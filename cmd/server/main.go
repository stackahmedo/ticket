package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: eticket api|migrate|outbox|worker|cleanup")
	}
	cfg, err := config()
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}
	pCfg.MaxConns = 10
	db, err := pgxpool.NewWithConfig(ctx, pCfg)
	if err != nil {
		log.Fatal(err)
	}
	a := &application{db: db, cache: redis.NewClient(&redis.Options{Addr: cfg.RedisAddr, Password: cfg.RedisPassword}), cfg: cfg}
	defer a.close()
	pingCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if err = db.Ping(pingCtx); err != nil {
		log.Fatalf("postgres connection: %v", err)
	}
	switch os.Args[1] {
	case "migrate":
		err = a.migrate(ctx)
	case "api":
		srv := &http.Server{Addr: ":" + cfg.Port, Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 90 * time.Second}
		go func() {
			<-ctx.Done()
			stopCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = srv.Shutdown(stopCtx)
		}()
		log.Printf("ETicket API listening on %s", srv.Addr)
		err = srv.ListenAndServe()
		if err == http.ErrServerClosed {
			err = nil
		}
	case "outbox":
		err = a.outboxLoop(ctx)
	case "worker":
		err = a.workerLoop(ctx)
	case "cleanup":
		err = a.cleanupLoop(ctx)
	default:
		log.Fatal("unknown command; choose api|migrate|outbox|worker|cleanup")
	}
	if err != nil {
		log.Fatal(err)
	}
}
