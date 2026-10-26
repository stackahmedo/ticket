package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

var _ = pgx.ErrNoRows
