package main

import (
	"errors"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type configuration struct {
	DatabaseURL   string
	RedisAddr     string
	RedisPassword string
	KafkaBrokers  []string
	JWTSecret     string
	MockPayments  bool
	Port          string
}

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func config() (configuration, error) {
	c := configuration{
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		RedisAddr:     env("REDIS_ADDR", "127.0.0.1:6379"),
		RedisPassword: os.Getenv("REDIS_PASSWORD"),
		KafkaBrokers:  strings.Split(env("KAFKA_BROKERS", "127.0.0.1:9092"), ","),
		JWTSecret:     os.Getenv("JWT_SECRET"),
		MockPayments:  os.Getenv("ENABLE_MOCK_CHECKOUT") == "true" && env("APP_ENV", "development") != "production",
		Port:          env("PORT", "8080"),
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL required")
	}
	if len(c.JWTSecret) < 32 {
		return c, errors.New("JWT_SECRET must be at least 32 characters")
	}
	return c, nil
}

type application struct {
	db    *pgxpool.Pool
	cache *redis.Client
	cfg   configuration
}

func (a *application) close() { a.db.Close(); _ = a.cache.Close() }
