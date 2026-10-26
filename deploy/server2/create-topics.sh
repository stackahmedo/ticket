#!/usr/bin/env bash
set -euo pipefail
for topic in reservation.created reservation.expired booking.confirmed ticket.checked_in; do
  docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:19092 --create --if-not-exists \
    --topic "$topic" --partitions 3 --replication-factor 1
done
