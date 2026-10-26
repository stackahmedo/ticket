.PHONY: tidy test build fmt migrate api

tidy:
	go mod tidy
fmt:
	gofmt -w ./cmd/server ./internal/schema
build:
	go build -o bin/eticket ./cmd/server
migrate:
	go run ./cmd/server migrate
api:
	go run ./cmd/server api
test:
	go test ./...
