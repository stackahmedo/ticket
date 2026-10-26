package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/twmb/franz-go/pkg/kgo"
)

func kafkaClient(c configuration, consumer bool) (*kgo.Client, error) {
	opts := []kgo.Opt{kgo.SeedBrokers(c.KafkaBrokers...)}
	if consumer {
		opts = append(opts, kgo.ConsumerGroup("eticket-notifications"), kgo.ConsumeTopics("booking.confirmed", "reservation.created", "ticket.checked_in"), kgo.DisableAutoCommit())
	}
	return kgo.NewClient(opts...)
}
func (a *application) outboxLoop(ctx context.Context) error {
	client, err := kafkaClient(a.cfg, false)
	if err != nil {
		return err
	}
	defer client.Close()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err = a.flushOutbox(ctx, client); err != nil && ctx.Err() == nil {
			log.Printf("outbox retry: %v", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func (a *application) flushOutbox(ctx context.Context, client *kgo.Client) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id, topic, aggregate string
	var payload []byte
	err = tx.QueryRow(ctx, `SELECT id,topic,aggregate_id,payload FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &topic, &aggregate, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// Sending while holding one row lock is intentional for this small MVP. Duplicates are possible after crash.
	pctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	record := &kgo.Record{Topic: topic, Key: []byte(aggregate), Value: payload, Headers: []kgo.RecordHeader{{Key: "event_id", Value: []byte(id)}}}
	if err = client.ProduceSync(pctx, record).FirstErr(); err != nil {
		return fmt.Errorf("kafka publish: %w", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE outbox_events SET published_at=now(),attempts=attempts+1 WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (a *application) workerLoop(ctx context.Context) error {
	client, err := kafkaClient(a.cfg, true)
	if err != nil {
		return err
	}
	defer client.Close()
	for ctx.Err() == nil {
		fetches := client.PollFetches(ctx)
		if ctx.Err() != nil {
			return nil
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			log.Printf("kafka fetch %s[%d]: %v", topic, partition, err)
		})
		var failed error
		fetches.EachRecord(func(rec *kgo.Record) {
			if failed != nil {
				return
			}
			if err := a.handleRecord(ctx, rec); err != nil {
				failed = err
				return
			}
			if err := client.CommitRecords(ctx, rec); err != nil {
				failed = err
			}
		})
		if failed != nil {
			return fmt.Errorf("worker stopped without acknowledging failed message: %w", failed)
		}
	}
	return nil
}
func (a *application) handleRecord(ctx context.Context, rec *kgo.Record) error {
	var eventID string
	for _, h := range rec.Headers {
		if h.Key == "event_id" {
			eventID = string(h.Value)
			break
		}
	}
	if eventID == "" {
		return errors.New("message missing event_id header")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `INSERT INTO processed_events(consumer,event_id) VALUES('notifications',$1) ON CONFLICT DO NOTHING`, eventID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}
	if rec.Topic == "booking.confirmed" {
		var message struct {
			OrderID     string `json:"order_id"`
			UserID      string `json:"user_id"`
			TicketCount int    `json:"ticket_count"`
		}
		if err = json.Unmarshal(rec.Value, &message); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO notifications(user_id,event_id,message) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, message.UserID, eventID, fmt.Sprintf("Booking %s confirmed; %d ticket(s) issued.", message.OrderID, message.TicketCount)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (a *application) cleanupLoop(ctx context.Context) error {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		if err := a.cleanupExpired(ctx); err != nil && ctx.Err() == nil {
			log.Printf("cleanup: %v", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func (a *application) cleanupExpired(ctx context.Context) error {
	// Lock one reservation first: confirmation follows the same reservation->seats lock ordering.
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id, eventID string
	err = tx.QueryRow(ctx, `SELECT id,event_id FROM reservations WHERE status='active' AND expires_at<=now() ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE event_seats SET status='available',reservation_id=NULL,hold_expires_at=NULL WHERE reservation_id=$1 AND status='held'`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE reservations SET status='expired' WHERE id=$1`, id); err != nil {
		return err
	}
	if err = outbox(ctx, tx, "reservation.expired", id, map[string]any{"reservation_id": id}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	a.invalidateSeats(ctx, eventID)
	return nil
}
