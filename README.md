# ETicket — By TozaiTech

**GitHub target:** `github.com/stackahmedo/ticket`.

Event ticket booking starter with **Go + PostgreSQL (Neon) + Kafka + Redis + Next.js** on **exactly two AWS EC2 instances in Tokyo**. Includes a functional customer UI, JWT authentication, sample concert and twelve seats, atomic multi-seat reservations, 10-minute holds, simulated confirmation, one-time ticket tokens, authenticated check-in, transactional outbox, Kafka notification worker, Redis availability caching and reservation cleanup.

**Current status:** Source files generated. This environment could not download Go/npm packages or access AWS, Neon or GitHub; compilation, Docker builds, integrated tests, actual deployments, and GitHub push are **not verified or performed**. The demo is not ready for real customers or payments.

## Architecture

```text
Browser --(eventual Cloudflare/TLS)--> EC2 Tokyo Server 1 (nginx)
                  ├── Next.js web :3000
                  ├── Go API :8080
                  ├── Go outbox publisher -- Kafka
                  ├── Go Kafka notification worker
                  └── Go reservation expiry cleanup
                              |
                  AWS VPC private network
                              |
                       EC2 Tokyo Server 2
                       ├── Kafka KRaft :9092
                       └── Redis :6379

Go API ------------------ TLS ------------------> Neon PostgreSQL (managed, outside AWS EC2)
```

## What's in the starter

- `cmd/server`: Go executable with commands `api`, `migrate`, `outbox`, `worker`, `cleanup`.
- `internal/schema/migrations`: initial database schema and clearly marked sample data.
- `web`: Next.js demo frontend, including registration, events, seat selection, reservation and simulated confirmation.
- `deploy/server1`: EC2 #1 Docker Compose and private-loopback nginx proxy.
- `deploy/server2`: EC2 #2 Docker Compose for Kafka KRaft and Redis.
- `scripts/smoke.sh`: end-to-end HTTP smoke test (consumes one available demo seat per run).

## Required before first deployment

1. AWS account with permission to provision two EC2 instances, a VPC, subnet routes, security groups, encrypted EBS and optionally Systems Manager / EC2 Instance Connect Endpoint.
2. Neon account and `DATABASE_URL` from your own project; choose a supported region and measure latency.
3. SSH/SSM access to both Ubuntu EC2 instances, Docker Engine and Compose installed.
4. Local Git installed, and GitHub account `stackahmedo` for publishing when you approve repository creation.
5. A domain for Cloudflare DNS and **HTTPS** later. No domain has been provided, so the initial EC2 deployment listens on *localhost:8088*, accessed via an SSH/SSM tunnel. Do NOT open unauthenticated checkout over public HTTP.

Never share database credentials or AWS secrets in a public Git repository or chat.

## 1. Provision exactly two EC2 instances (Tokyo)

AWS Region: `ap-northeast-1`. Suggested initial sizing, benchmark later:

- `eticket-app`: 4 GB RAM class; ~40 GB encrypted gp3 EBS; Ubuntu; Go API + frontend + outbox/worker/cleanup + nginx.
- `eticket-infra`: 8 GB RAM class; ~100 GB encrypted gp3 EBS; Ubuntu; Kafka KRaft single broker + Redis. Same VPC. Prefer no public IP; private connectivity to first server. If isolated, provide image access via NAT or controlled artifact distribution.

Security groups: Server 2 allows TCP 9092 and 6379 **only from Server 1 security group**. No public Redis/Kafka ports. SSH only from trusted administrator network or use SSM. The reverse proxy on Server 1 binds to loopback, even if 80/443 are otherwise configured.

**Production limitations:** One Kafka broker and Redis node lack high availability. Current Kafka listener uses plaintext and Redis password without TLS, appropriate only for explicitly controlled development/staging. Harden or replace with managed/replicated options before real payment traffic. Avoid using mock payment flows outside staging.

## 2. Prepare Neon

Create a database at https://console.neon.tech . The direct PostgreSQL connection is suitable for the migration command; use a connection pool appropriate to your Neon plan. Never commit `DATABASE_URL`.

## 3. Start Kafka and Redis on EC2 Server 2

Copy this repository to Server 2 or transfer only `deploy/server2`. In `deploy/server2`:

```bash
cp .env.example .env
# Replace SERVER2_PRIVATE_IP, REDIS_PASSWORD, KAFKA_CLUSTER_ID with real values.
# Generate the Kafka cluster ID using the official Kafka image:
docker run --rm --entrypoint /opt/kafka/bin/kafka-storage.sh apache/kafka:3.8.0 random-uuid

# Edit .env to paste that UUID, your private IP and a random strong Redis password.
docker compose --env-file .env config
docker compose --env-file .env up -d
./create-topics.sh
```

Topic creation uses the Docker network's internal Kafka hostname (listener port 19092). Broker advertises the private EC2 IP to clients on Server 1.

## 4. Configure and deploy on EC2 Server 1

From the repo root, after copying the project onto Server 1:

```bash
cp deploy/server1/.env.example deploy/server1/.env
# Edit DATABASE_URL, JWT_SECRET, REDIS_PASSWORD and server2 private IP.
# APP_ENV=staging, ENABLE_MOCK_CHECKOUT=true only for the simulated checkout MVP.

docker compose --env-file deploy/server1/.env -f deploy/server1/compose.yml config
# Apply migrations before starting the API/workers:
docker compose --env-file deploy/server1/.env -f deploy/server1/compose.yml run --rm api migrate

docker compose --env-file deploy/server1/.env -f deploy/server1/compose.yml up -d --build
```

Compose project paths are relative to `deploy/server1/compose.yml`. Ensure secrets are readable only by deployment administrators (`chmod 600 deploy/server1/.env`), and use AWS SSM Parameter Store/Secrets Manager when hardening.

`DATABASE_URL` must use `sslmode=require` or stricter verification settings supported by your environment. The app's database pool caps connections at 10 per Go process.

### Access without a domain

With SSH allowed *only* from your trusted IP to Server 1:

```bash
ssh -N -L 8088:127.0.0.1:8088 ubuntu@YOUR_SERVER1_PUBLIC_IP
```

Open `http://localhost:8088` **on your local machine**. This HTTP address is tunneled through SSH and is not published on the internet. Alternatively use AWS Systems Manager port-forwarding if you deploy Server 1 without a public IP.

Once a domain is available: provision origin TLS, configure a Cloudflare proxied DNS record, use Full (strict), and bind the reverse proxy to the intended HTTPS ingress. The included loopback Nginx is **not** a finished public Cloudflare setup.

## 5. Validate the proof-of-concept

```bash
# From your machine with SSH tunnel running:
BASE=http://localhost:8088 ./scripts/smoke.sh
```

The seeded demo event ID is `30000000-0000-4000-8000-000000000001` with twelve ¥3,000 seats. The smoke script registers one new test user, holds one available seat and confirms a *simulated* payment. Run `curl http://localhost:8088/healthz` before testing.

## 6. Backend development without two EC2 instances

The deployment target is AWS Tokyo, but Go can also run locally after services and Neon are configured:

```bash
go mod tidy
export DATABASE_URL='your-neon-connection-url'
export JWT_SECRET='at-least-32-random-characters-go-here'
export KAFKA_BROKERS='PRIVATE_OR_LOCAL_KAFKA_HOST:9092'
export REDIS_ADDR='PRIVATE_OR_LOCAL_REDIS_HOST:6379'
export REDIS_PASSWORD='your-secret'
export APP_ENV='staging'
export ENABLE_MOCK_CHECKOUT=true
go run ./cmd/server migrate
go run ./cmd/server api
# Other shells: go run ./cmd/server outbox; go run ./cmd/server worker; go run ./cmd/server cleanup
```

## API list

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness |
| GET | `/readyz` | PostgreSQL readiness |
| POST | `/v1/auth/register` | Customer registration |
| POST | `/v1/auth/login` | Get access JWT |
| GET | `/v1/events` | Published future events |
| GET | `/v1/events/{id}/seats` | Availability (3-second Redis cache) |
| POST | `/v1/reservations` | Hold 1–6 event-seat IDs, 10-minute expiry; requires Bearer JWT and `Idempotency-Key` header |
| POST | `/v1/reservations/{id}/confirm` | Confirm **simulated** payment; returns one-time QR secrets |
| GET | `/v1/me/orders` | Current user's confirmed bookings |
| GET | `/v1/me/notifications` | Kafka-consumer-generated booking notifications |
| POST | `/v1/checkins` | Organizer/Admin validates one-time QR secret; organizer must own event |

`POST /v1/reservations` JSON:

```json
{"event_id":"30000000-0000-4000-8000-000000000001", "seat_ids":["event_seat_id_from_GET_seats"]}
```

Important: `seat_ids` means identifiers returned in the event's seat availability API (`event_seats.id`), **not** the physical venue `seats.id`.

## Safety and correctness

- Database `event_seats` row locks serialize competing seat reservations. Redis availability is advisory only.
- Reservation retries are serialized per `(user,idempotency_key)` using PostgreSQL advisory transaction locks.
- Confirmation and expiry both lock the reservation before mutating its seats.
- PostgreSQL outbox events are published to Kafka at least once; consumer deduplicates in `processed_events`.
- Ticket secrets are random, only stored in hashed form, and revealed **once** on initial confirmation.
- Demo ticket scanning expects the 64-character hex token; the frontend does not render a graphic QR yet.
- Organizer creation, real payments, refunds, seat-layout editor, email delivery, browser-stored sessions, CAPTCHA, anti-bot waiting room, scalable metrics and backups are future features.

## Important limitations for production

- This is an **MVP starter**, not a hardened production ticket-selling service. It does not integrate a real payment gateway or guarantee a seamless recovery of one-time ticket tokens if the confirmation response is lost. Replace with a secure ticket retrieval/claim design.
- The initial authentication endpoint needs comprehensive rate limiting, email verification, password reset and stronger session lifecycle management before internet exposure.
- Current Kafka failure handling stops the worker so it can restart without acknowledging a failing event. Add backoff, poison-message handling, dead-letter queues and monitoring.
- Run concurrency/load tests against the actual EC2 and Neon environment before public launch.
- Add migration tests, end-to-end tests, performance benchmarking, AWS IAM/SSM and disaster-recovery drills.

## Immediate next actions

1. Create your Neon database and the two EC2 instances in Tokyo.
2. Install Docker/Compose and apply the Server 2 infrastructure config.
3. Update Server 1 secrets and run migrations; start the Compose project.
4. Access through SSH/SSM tunneling until you have a real domain for Cloudflare HTTPS.
5. Validate the demo, then push the repository to `github.com/stackahmedo/eticket-by-tozaitech`.

The folder is a source-code artifact and has **not** been published or deployed.
