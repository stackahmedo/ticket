package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func uuidString(s string) bool { _, err := uuid.Parse(s); return err == nil }
func uniqueSortedIDs(in []string) ([]string, error) {
	if len(in) == 0 || len(in) > 6 {
		return nil, errors.New("select between 1 and 6 seats")
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !uuidString(s) || seen[s] {
			return nil, errors.New("invalid or duplicated seat ID")
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out, nil
}
func outbox(ctx context.Context, tx pgx.Tx, topic, aggregate string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO outbox_events(topic,aggregate_id,payload) VALUES($1,$2,$3)`, topic, aggregate, data)
	return err
}
func (a *application) invalidateSeats(ctx context.Context, id string) {
	if err := a.cache.Del(ctx, "event:"+id+":seats").Err(); err != nil {
		log.Printf("redis invalidate: %v", err)
	}
}
func (a *application) holdSeats(w http.ResponseWriter, r *http.Request) {
	var req struct {
		EventID string   `json:"event_id"`
		SeatIDs []string `json:"seat_ids"`
	}
	if body(r, &req) != nil || !uuidString(req.EventID) {
		fail(w, 400, "invalid event or seat request")
		return
	}
	ids, err := uniqueSortedIDs(req.SeatIDs)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(key) < 12 || len(key) > 128 {
		fail(w, 400, "Idempotency-Key must be 12–128 characters")
		return
	}
	reqHash := hash(req.EventID + "|" + strings.Join(ids, ","))
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		fail(w, 500, "transaction failed")
		return
	}
	defer tx.Rollback(ctx)
	// Serialize retries with the same (user, key); prevents same-key concurrent duplicate holds.
	_, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, user(r).ID+":"+key)
	if err != nil {
		fail(w, 500, "could not lock request")
		return
	}
	var id, status, oldHash, event string
	var expires time.Time
	err = tx.QueryRow(ctx, `SELECT id,status,request_hash,event_id,expires_at FROM reservations WHERE user_id=$1 AND idempotency_key=$2`, user(r).ID, key).Scan(&id, &status, &oldHash, &event, &expires)
	if err == nil {
		if oldHash != reqHash {
			fail(w, 409, "idempotency key belongs to different request")
			return
		}
		_ = tx.Commit(ctx)
		respond(w, 200, map[string]any{"reservation_id": id, "status": status, "expires_at": expires})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		fail(w, 500, "request lookup failed")
		return
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE id=$1 AND status='published' AND starts_at>now())`, req.EventID).Scan(&exists); err != nil || !exists {
		fail(w, 404, "event unavailable")
		return
	}
	var total int64
	for _, seatID := range ids {
		var price int64
		var state string
		var holdExpires *time.Time
		err = tx.QueryRow(ctx, `SELECT price_yen,status,hold_expires_at FROM event_seats WHERE id=$1 AND event_id=$2 FOR UPDATE`, seatID, req.EventID).Scan(&price, &state, &holdExpires)
		if errors.Is(err, pgx.ErrNoRows) {
			fail(w, 404, "seat does not belong to event")
			return
		}
		if err != nil {
			fail(w, 500, "seat lookup failed")
			return
		}
		if state == "sold" || (state == "held" && holdExpires != nil && holdExpires.After(time.Now())) {
			fail(w, 409, "one or more seats are unavailable")
			return
		}
		total += price
	}
	if err = tx.QueryRow(ctx, `INSERT INTO reservations(user_id,event_id,idempotency_key,request_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes') RETURNING id,expires_at`, user(r).ID, req.EventID, key, reqHash).Scan(&id, &expires); err != nil {
		fail(w, 500, "could not create reservation")
		return
	}
	for _, seatID := range ids {
		_, err = tx.Exec(ctx, `UPDATE event_seats SET status='held',reservation_id=$1,hold_expires_at=$2,order_id=NULL WHERE id=$3`, id, expires, seatID)
		if err != nil {
			fail(w, 500, "could not hold seat")
			return
		}
	}
	if err = outbox(ctx, tx, "reservation.created", id, map[string]any{"reservation_id": id, "user_id": user(r).ID}); err != nil {
		fail(w, 500, "could not create event")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, 500, "could not commit reservation")
		return
	}
	a.invalidateSeats(ctx, req.EventID)
	respond(w, 201, map[string]any{"reservation_id": id, "status": "active", "total_yen": total, "expires_at": expires})
}
func newQRToken() (string, string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", err
	}
	raw := hex.EncodeToString(bytes)
	return raw, hash(raw), nil
}
func (a *application) confirm(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.MockPayments {
		fail(w, 403, "mock payment checkout disabled")
		return
	}
	reservationID := r.PathValue("id")
	if !uuidString(reservationID) {
		fail(w, 400, "invalid reservation id")
		return
	}
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		fail(w, 500, "transaction failed")
		return
	}
	defer tx.Rollback(ctx)
	var status, eventID string
	var expires time.Time
	err = tx.QueryRow(ctx, `SELECT status,event_id,expires_at FROM reservations WHERE id=$1 AND user_id=$2 FOR UPDATE`, reservationID, user(r).ID).Scan(&status, &eventID, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "reservation not found")
		return
	}
	if err != nil {
		fail(w, 500, "reservation lookup failed")
		return
	}
	if status == "confirmed" {
		var orderID string
		if err = tx.QueryRow(ctx, `SELECT id FROM orders WHERE reservation_id=$1`, reservationID).Scan(&orderID); err != nil {
			fail(w, 500, "order lookup failed")
			return
		}
		_ = tx.Commit(ctx)
		respond(w, 200, map[string]any{"order_id": orderID, "status": "confirmed", "note": "already confirmed; initial QR secrets are not replayed"})
		return
	}
	if status != "active" || !expires.After(time.Now()) {
		fail(w, 409, "reservation expired or inactive")
		return
	}
	// Lock seat rows only after the reservation row; cleanup follows the same lock ordering.
	rows, err := tx.Query(ctx, `SELECT id,price_yen,status FROM event_seats WHERE reservation_id=$1 ORDER BY id FOR UPDATE`, reservationID)
	if err != nil {
		fail(w, 500, "seat query failed")
		return
	}
	type heldSeat struct {
		id     string
		price  int64
		status string
	}
	seats := []heldSeat{}
	var total int64
	for rows.Next() {
		var s heldSeat
		if err = rows.Scan(&s.id, &s.price, &s.status); err != nil {
			rows.Close()
			fail(w, 500, "seat scan failed")
			return
		}
		seats = append(seats, s)
		total += s.price
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(seats) == 0 {
		fail(w, 409, "no held seats")
		return
	}
	for _, s := range seats {
		if s.status != "held" {
			fail(w, 409, "seat is no longer held")
			return
		}
	}
	var orderID string
	if err = tx.QueryRow(ctx, `INSERT INTO orders(user_id,reservation_id,amount_yen,status) VALUES($1,$2,$3,'confirmed') RETURNING id`, user(r).ID, reservationID, total).Scan(&orderID); err != nil {
		fail(w, 500, "could not create order")
		return
	}
	type ticketInfo struct {
		ID    string `json:"ticket_id"`
		Token string `json:"qr_token"`
	}
	issued := []ticketInfo{}
	for _, seat := range seats {
		if _, err = tx.Exec(ctx, `UPDATE event_seats SET status='sold',reservation_id=NULL,hold_expires_at=NULL,order_id=$1 WHERE id=$2`, orderID, seat.id); err != nil {
			fail(w, 500, "could not sell seat")
			return
		}
		raw, digest, e := newQRToken()
		if e != nil {
			fail(w, 500, "could not generate ticket")
			return
		}
		var ticketID string
		if err = tx.QueryRow(ctx, `INSERT INTO tickets(order_id,event_seat_id,token_hash) VALUES($1,$2,$3) RETURNING id`, orderID, seat.id, digest).Scan(&ticketID); err != nil {
			fail(w, 500, "could not issue ticket")
			return
		}
		issued = append(issued, ticketInfo{ticketID, raw})
	}
	if _, err = tx.Exec(ctx, `UPDATE reservations SET status='confirmed' WHERE id=$1`, reservationID); err != nil {
		fail(w, 500, "could not confirm hold")
		return
	}
	if err = outbox(ctx, tx, "booking.confirmed", orderID, map[string]any{"order_id": orderID, "user_id": user(r).ID, "ticket_count": len(seats)}); err != nil {
		fail(w, 500, "could not enqueue event")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, 500, "could not commit booking")
		return
	}
	a.invalidateSeats(ctx, eventID)
	respond(w, 201, map[string]any{"order_id": orderID, "status": "confirmed", "amount_yen": total, "tickets": issued, "warning": "Save QR tokens securely; they are returned only once."})
}
func (a *application) checkIn(w http.ResponseWriter, r *http.Request) {
	who := user(r)
	if who.Role != "organizer" && who.Role != "admin" {
		fail(w, 403, "organizer permission required")
		return
	}
	var req struct {
		Token string `json:"qr_token"`
	}
	if body(r, &req) != nil || len(req.Token) != 64 {
		fail(w, 400, "valid QR token required")
		return
	}
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		fail(w, 500, "transaction failed")
		return
	}
	defer tx.Rollback(ctx)
	var ticketID, orderID string
	err = tx.QueryRow(ctx, `UPDATE tickets t SET status='used',used_at=now() FROM event_seats es,events e WHERE t.event_seat_id=es.id AND es.event_id=e.id AND t.token_hash=$1 AND t.status='valid' AND (e.organizer_id=$2 OR $3='admin') RETURNING t.id,t.order_id`, hash(req.Token), who.ID, who.Role).Scan(&ticketID, &orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 409, "ticket invalid or already used")
		return
	}
	if err != nil {
		fail(w, 500, "check-in failed")
		return
	}
	if err = outbox(ctx, tx, "ticket.checked_in", ticketID, map[string]any{"ticket_id": ticketID, "order_id": orderID}); err != nil {
		fail(w, 500, "check-in event failed")
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, 500, "check-in not committed")
		return
	}
	respond(w, 200, map[string]string{"ticket_id": ticketID, "status": "used"})
}
