#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://localhost:8088}"
: "${EMAIL:=customer-$(date +%s)@example.test}"
: "${PASSWORD:=ChangeThisStrongPass1234}"
echo 'GET /healthz:'
curl -fsS "$BASE/healthz"; echo
printf '\nRegister sample user:\n'
REGISTER=$(curl -fsS "$BASE/v1/auth/register" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
echo "$REGISTER"
TOKEN=$(printf '%s' "$REGISTER" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
EVENT=30000000-0000-4000-8000-000000000001
printf '\nAvailable seats:\n'
curl -fsS "$BASE/v1/events/$EVENT/seats"; echo
SEAT=$(curl -fsS "$BASE/v1/events/$EVENT/seats" | python3 -c 'import json,sys;print(next(s["id"] for s in json.load(sys.stdin) if s["status"]=="available"))')
HOLD=$(curl -fsS "$BASE/v1/reservations" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: $(date +%s)-demo-request" -d "{\"event_id\":\"$EVENT\",\"seat_ids\":[\"$SEAT\"]}")
echo "$HOLD"
RES=$(printf '%s' "$HOLD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["reservation_id"])')
printf '\nConfirm simulated checkout:\n'
curl -fsS "$BASE/v1/reservations/$RES/confirm" -H "Authorization: Bearer $TOKEN" -X POST;echo
