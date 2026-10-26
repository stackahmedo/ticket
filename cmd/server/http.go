package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

type principal struct {
	ID   string
	Role string
}
type principalKey struct{}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]string{"status": "ok", "service": "ETicket — By TozaiTech"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if a.db.Ping(ctx) != nil {
			fail(w, 503, "database unavailable")
			return
		}
		respond(w, 200, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("POST /v1/auth/register", a.register)
	mux.HandleFunc("POST /v1/auth/login", a.login)
	mux.HandleFunc("GET /v1/events", a.listEvents)
	mux.HandleFunc("GET /v1/events/{id}/seats", a.listSeats)
	mux.Handle("POST /v1/reservations", a.auth(http.HandlerFunc(a.holdSeats)))
	mux.Handle("POST /v1/reservations/{id}/confirm", a.auth(http.HandlerFunc(a.confirm)))
	mux.Handle("GET /v1/me/orders", a.auth(http.HandlerFunc(a.myOrders)))
	mux.Handle("GET /v1/me/notifications", a.auth(http.HandlerFunc(a.myNotifications)))
	mux.Handle("POST /v1/checkins", a.auth(http.HandlerFunc(a.checkIn)))
	mux.Handle("GET /v1/admin/stats", a.adminAuth(http.HandlerFunc(a.adminStats)))
	mux.Handle("GET /v1/admin/orders", a.adminAuth(http.HandlerFunc(a.adminOrders)))
	mux.Handle("GET /v1/admin/tickets", a.adminAuth(http.HandlerFunc(a.adminTickets)))
	mux.Handle("POST /v1/admin/events", a.adminAuth(http.HandlerFunc(a.adminCreateEvent)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, msg string) {
	respond(w, status, map[string]string{"error": msg})
}
func body(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if dec.Decode(new(any)) != io.EOF {
		return errors.New("unexpected trailing data")
	}
	return nil
}
func hash(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }
func (a *application) register(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if body(r, &in) != nil {
		fail(w, 400, "invalid request")
		return
	}
	in.Email = strings.ToLower(strings.TrimSpace(in.Email))
	if len(in.Email) > 254 || !strings.Contains(in.Email, "@") || len(in.Password) < 12 || len(in.Password) > 72 {
		fail(w, 400, "valid email and password of 12–72 bytes required")
		return
	}
	pw, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		fail(w, 500, "password unavailable")
		return
	}
	var id string
	err = a.db.QueryRow(r.Context(), `INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id`, in.Email, string(pw)).Scan(&id)
	if err != nil {
		fail(w, 409, "account already exists or invalid data")
		return
	}
	token, err := a.issueToken(id, "customer")
	if err != nil {
		fail(w, 500, "could not issue session")
		return
	}
	respond(w, 201, map[string]string{"token": token, "user_id": id})
}
func (a *application) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if body(r, &in) != nil {
		fail(w, 400, "invalid request")
		return
	}
	var id, pw, role string
	err := a.db.QueryRow(r.Context(), `SELECT id,password_hash,role FROM users WHERE email=$1`, strings.ToLower(strings.TrimSpace(in.Email))).Scan(&id, &pw, &role)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(pw), []byte(in.Password)) != nil {
		fail(w, 401, "incorrect credentials")
		return
	}
	token, err := a.issueToken(id, role)
	if err != nil {
		fail(w, 500, "could not issue session")
		return
	}
	respond(w, 200, map[string]string{"token": token, "user_id": id, "role": role})
}
func (a *application) issueToken(id, role string) (string, error) {
	claims := jwt.MapClaims{"sub": id, "role": role, "iss": "eticket-tozaitech", "aud": "eticket-api", "exp": time.Now().Add(12 * time.Hour).Unix(), "iat": time.Now().Unix()}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(a.cfg.JWTSecret))
}
func (a *application) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		val := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if val == "" || val == r.Header.Get("Authorization") {
			fail(w, 401, "bearer token required")
			return
		}
		claims := jwt.MapClaims{}
		token, err := jwt.ParseWithClaims(val, claims, func(t *jwt.Token) (any, error) {
			if t.Method != jwt.SigningMethodHS256 {
				return nil, errors.New("wrong signature method")
			}
			return []byte(a.cfg.JWTSecret), nil
		}, jwt.WithIssuer("eticket-tozaitech"), jwt.WithAudience("eticket-api"), jwt.WithExpirationRequired())
		if err != nil || !token.Valid {
			fail(w, 401, "invalid or expired token")
			return
		}
		id, _ := claims["sub"].(string)
		role, _ := claims["role"].(string)
		if _, err := uuid.Parse(id); err != nil {
			fail(w, 401, "invalid user id")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, principal{ID: id, Role: role})))
	})
}
func user(r *http.Request) principal { return r.Context().Value(principalKey{}).(principal) }
func (a *application) listEvents(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `SELECT id,title,starts_at FROM events WHERE status='published' AND starts_at>now() ORDER BY starts_at LIMIT 100`)
	if err != nil {
		fail(w, 500, "query failed")
		return
	}
	defer rows.Close()
	type event struct {
		ID       string    `json:"id"`
		Title    string    `json:"title"`
		StartsAt time.Time `json:"starts_at"`
	}
	events := []event{}
	for rows.Next() {
		var e event
		if err := rows.Scan(&e.ID, &e.Title, &e.StartsAt); err != nil {
			fail(w, 500, "scan failed")
			return
		}
		events = append(events, e)
	}
	if rows.Err() != nil {
		fail(w, 500, "query failed")
		return
	}
	respond(w, 200, events)
}
func (a *application) listSeats(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := uuid.Parse(id); err != nil {
		fail(w, 400, "invalid event id")
		return
	}
	key := "event:" + id + ":seats"
	if cached, err := a.cache.Get(r.Context(), key).Result(); err == nil {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(cached))
		return
	} else if err != redis.Nil {
		log.Printf("redis miss/unavailable: %v", err)
	}
	rows, err := a.db.Query(r.Context(), `SELECT es.id,s.section,s.row_label,s.seat_number,es.price_yen,
 CASE WHEN es.status='held' AND es.hold_expires_at<=now() THEN 'available' ELSE es.status END
 FROM event_seats es JOIN seats s ON s.id=es.seat_id
 JOIN events e ON e.id=es.event_id AND e.venue_id=s.venue_id
 WHERE es.event_id=$1 AND e.status='published' ORDER BY s.section,s.row_label,s.seat_number`, id)
	if err != nil {
		fail(w, 500, "query failed")
		return
	}
	defer rows.Close()
	type seat struct {
		ID       string `json:"id"`
		Section  string `json:"section"`
		Row      string `json:"row"`
		Number   int    `json:"number"`
		PriceYen int64  `json:"price_yen"`
		Status   string `json:"status"`
	}
	result := []seat{}
	for rows.Next() {
		var x seat
		if err = rows.Scan(&x.ID, &x.Section, &x.Row, &x.Number, &x.PriceYen, &x.Status); err != nil {
			fail(w, 500, "scan failed")
			return
		}
		result = append(result, x)
	}
	if rows.Err() != nil {
		fail(w, 500, "query failed")
		return
	}
	raw, _ := json.Marshal(result)
	_ = a.cache.Set(r.Context(), key, raw, 3*time.Second).Err()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(append(raw, '\n'))
}
func (a *application) myOrders(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `SELECT id,reservation_id,amount_yen,status,created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, user(r).ID)
	if err != nil {
		fail(w, 500, "query failed")
		return
	}
	defer rows.Close()
	type order struct {
		ID            string    `json:"id"`
		ReservationID string    `json:"reservation_id"`
		AmountYen     int64     `json:"amount_yen"`
		Status        string    `json:"status"`
		CreatedAt     time.Time `json:"created_at"`
	}
	result := []order{}
	for rows.Next() {
		var x order
		if err = rows.Scan(&x.ID, &x.ReservationID, &x.AmountYen, &x.Status, &x.CreatedAt); err != nil {
			fail(w, 500, "scan failed")
			return
		}
		result = append(result, x)
	}
	if rows.Err() != nil {
		fail(w, 500, "query failed")
		return
	}
	respond(w, 200, result)
}
func (a *application) myNotifications(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `SELECT message,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, user(r).ID)
	if err != nil {
		fail(w, 500, "query failed")
		return
	}
	defer rows.Close()
	result := []map[string]any{}
	for rows.Next() {
		var msg string
		var t time.Time
		if err = rows.Scan(&msg, &t); err != nil {
			fail(w, 500, "scan failed")
			return
		}
		result = append(result, map[string]any{"message": msg, "created_at": t})
	}
	if rows.Err() != nil {
		fail(w, 500, "query failed")
		return
	}
	respond(w, 200, result)
}

func (a *application) adminAuth(next http.Handler) http.Handler {
	return a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who := user(r)
		if who.Role != "admin" && who.Role != "organizer" {
			fail(w, 403, "admin or organizer permission required")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (a *application) adminStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var stats struct {
		TotalRevenueYen    int64 `json:"total_revenue_yen"`
		TotalOrders        int   `json:"total_orders"`
		TotalTickets       int   `json:"total_tickets"`
		UsedTickets        int   `json:"used_tickets"`
		ActiveReservations int   `json:"active_reservations"`
		TotalUsers         int   `json:"total_users"`
		PendingOutbox      int   `json:"pending_outbox"`
	}
	_ = a.db.QueryRow(ctx, `SELECT COALESCE(SUM(amount_yen), 0) FROM orders WHERE status='confirmed'`).Scan(&stats.TotalRevenueYen)
	_ = a.db.QueryRow(ctx, `SELECT COUNT(*) FROM orders`).Scan(&stats.TotalOrders)
	_ = a.db.QueryRow(ctx, `SELECT COUNT(*) FROM tickets`).Scan(&stats.TotalTickets)
	_ = a.db.QueryRow(ctx, `SELECT COUNT(*) FROM tickets WHERE status='used'`).Scan(&stats.UsedTickets)
	_ = a.db.QueryRow(ctx, `SELECT COUNT(*) FROM reservations WHERE status='active' AND expires_at > now()`).Scan(&stats.ActiveReservations)
	_ = a.db.QueryRow(ctx, `SELECT COUNT(*) FROM users`).Scan(&stats.TotalUsers)
	_ = a.db.QueryRow(ctx, `SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL`).Scan(&stats.PendingOutbox)
	respond(w, 200, stats)
}

func (a *application) adminOrders(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `
		SELECT o.id, u.email, o.amount_yen, o.status, o.created_at, COUNT(t.id) as ticket_count
		FROM orders o
		JOIN users u ON u.id = o.user_id
		LEFT JOIN tickets t ON t.order_id = o.id
		GROUP BY o.id, u.email, o.amount_yen, o.status, o.created_at
		ORDER BY o.created_at DESC
		LIMIT 50
	`)
	if err != nil {
		fail(w, 500, "query failed")
		return
	}
	defer rows.Close()
	type adminOrder struct {
		ID            string    `json:"id"`
		CustomerEmail string    `json:"customer_email"`
		AmountYen     int64     `json:"amount_yen"`
		Status        string    `json:"status"`
		CreatedAt     time.Time `json:"created_at"`
		TicketCount   int       `json:"ticket_count"`
	}
	list := []adminOrder{}
	for rows.Next() {
		var o adminOrder
		if err := rows.Scan(&o.ID, &o.CustomerEmail, &o.AmountYen, &o.Status, &o.CreatedAt, &o.TicketCount); err == nil {
			list = append(list, o)
		}
	}
	respond(w, 200, list)
}

func (a *application) adminTickets(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.Query(r.Context(), `
		SELECT t.id, t.order_id, e.title, s.section, s.row_label, s.seat_number, t.status, t.created_at, t.used_at
		FROM tickets t
		JOIN event_seats es ON es.id = t.event_seat_id
		JOIN events e ON e.id = es.event_id
		JOIN seats s ON s.id = es.seat_id
		ORDER BY t.created_at DESC
		LIMIT 50
	`)
	if err != nil {
		fail(w, 500, "query failed")
		return
	}
	defer rows.Close()
	type ticketRow struct {
		ID         string     `json:"id"`
		OrderID    string     `json:"order_id"`
		EventTitle string     `json:"event_title"`
		Section    string     `json:"section"`
		Row        string     `json:"row"`
		Number     int        `json:"number"`
		Status     string     `json:"status"`
		CreatedAt  time.Time  `json:"created_at"`
		UsedAt     *time.Time `json:"used_at"`
	}
	list := []ticketRow{}
	for rows.Next() {
		var t ticketRow
		if err := rows.Scan(&t.ID, &t.OrderID, &t.EventTitle, &t.Section, &t.Row, &t.Number, &t.Status, &t.CreatedAt, &t.UsedAt); err == nil {
			list = append(list, t)
		}
	}
	respond(w, 200, list)
}

func (a *application) adminCreateEvent(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title     string `json:"title"`
		PriceYen  int64  `json:"price_yen"`
		DaysAhead int    `json:"days_ahead"`
		SeatCount int    `json:"seat_count"`
	}
	if body(r, &in) != nil || strings.TrimSpace(in.Title) == "" {
		fail(w, 400, "valid event title required")
		return
	}
	if in.PriceYen <= 0 {
		in.PriceYen = 3000
	}
	if in.DaysAhead <= 0 {
		in.DaysAhead = 14
	}
	if in.SeatCount <= 0 || in.SeatCount > 24 {
		in.SeatCount = 12
	}
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		fail(w, 500, "transaction error")
		return
	}
	defer tx.Rollback(ctx)
	var eventID string
	venueID := "20000000-0000-4000-8000-000000000001"
	organizerID := user(r).ID
	startsAt := time.Now().Add(time.Duration(in.DaysAhead) * 24 * time.Hour)
	err = tx.QueryRow(ctx, `INSERT INTO events(venue_id, organizer_id, title, starts_at, status) VALUES($1, $2, $3, $4, 'published') RETURNING id`, venueID, organizerID, in.Title, startsAt).Scan(&eventID)
	if err != nil {
		fail(w, 500, "could not create event")
		return
	}
	for i := 1; i <= in.SeatCount; i++ {
		seatID := fmt.Sprintf("40000000-0000-4000-8000-%012d", i)
		_, _ = tx.Exec(ctx, `INSERT INTO event_seats(event_id, seat_id, price_yen) VALUES($1, $2, $3) ON CONFLICT DO NOTHING`, eventID, seatID, in.PriceYen)
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, 500, "commit failed")
		return
	}
	respond(w, 201, map[string]any{"event_id": eventID, "title": in.Title, "seats_created": in.SeatCount})
}

var _ = pgx.ErrNoRows

