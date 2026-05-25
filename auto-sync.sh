#!/bin/bash
while true; do
  sleep 5
  TOKEN=$(curl -sS -X POST http://localhost:4000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username": "superadmin", "password": "password"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)
  curl -sS -X POST http://localhost:4000/api/devices/69f543605184be5c985be6d0/sync \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{}' > /dev/null 2>&1
done
