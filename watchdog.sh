#!/bin/bash
LAST_RESET_MIN=""
while true; do
  # 1. Keep accept filter active
  curl -sS -X POST http://localhost:4500/devices/set-accept-filter \
    -H "Content-Type: application/json" \
    -d '{"allowAll": true, "useSSL": true}' > /dev/null 2>&1

  # 2. Get fresh token
  TOKEN=$(curl -sS -X POST http://localhost:4000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username": "superadmin", "password": "password"}' \
    | grep -o '"token":"[^"]*' | cut -d'"' -f4)

  if [ -z "$TOKEN" ]; then
    sleep 5
    continue
  fi

  # 3. Reset cursor if stuck (once per 5-minute slot)
  MINUTE=$(date +%M)
  if [ $((10#$MINUTE % 5)) -eq 0 ] && [ "$MINUTE" != "$LAST_RESET_MIN" ]; then
    curl -sS -X POST http://localhost:4000/api/devices/69f5c831a8c71f7f073b3906/reset-log-cursor \
      -H "Authorization: Bearer $TOKEN" > /dev/null 2>&1
    echo "[$(date '+%H:%M:%S')] Cursor reset"
    LAST_RESET_MIN="$MINUTE"
  fi

  echo "[$(date '+%H:%M:%S')] Watchdog OK"
  sleep 5
done
