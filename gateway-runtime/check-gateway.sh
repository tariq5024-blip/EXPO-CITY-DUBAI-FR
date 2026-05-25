#!/bin/bash
# Validate the complete Suprema gateway + Docker stack health.
# Usage: bash gateway-runtime/check-gateway.sh

CERT_DIR="$(cd "$(dirname "$0")/cert" && pwd)"
GW_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0

ok()   { echo "  [OK]  $1"; ((PASS++)); }
fail() { echo "  [!!]  $1"; ((FAIL++)); }
info() { echo "  [-]   $1"; }

echo "================================================="
echo " Suprema Gateway Health Check"
echo "================================================="

echo ""
echo "--- Binary & EULA ---"
if [ -f "$GW_DIR/device_gateway_linux_x64" ] && [ -x "$GW_DIR/device_gateway_linux_x64" ]; then
  ok "Binary exists and is executable"
else
  fail "Binary missing or not executable: $GW_DIR/device_gateway_linux_x64"
fi
[ -f "$GW_DIR/EULA.txt" ]                 && ok "EULA.txt present"                || fail "EULA.txt missing"
[ -f "$GW_DIR/config.json" ]              && ok "config.json present"             || fail "config.json missing"

echo ""
echo "--- Certificates ---"
for f in ca.crt ca_key.pem server.crt server_key.pem; do
  [ -f "$CERT_DIR/$f" ] && ok "$f exists" || fail "$f MISSING"
done

if [ -f "$CERT_DIR/ca.crt" ] && [ -f "$CERT_DIR/server.crt" ]; then
  openssl verify -CAfile "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt" > /dev/null 2>&1 \
    && ok "server.crt verifies against ca.crt" \
    || fail "server.crt does NOT verify against ca.crt — run renew-certs.sh"

  EXPIRY=$(openssl x509 -in "$CERT_DIR/server.crt" -noout -enddate 2>/dev/null | cut -d= -f2)
  DAYS=$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))
  [ "$DAYS" -gt 30 ] && ok "Cert valid for $DAYS days (expires: $EXPIRY)" \
                      || fail "Cert expires in $DAYS days — run renew-certs.sh soon"
fi

echo ""
echo "--- Systemd Service ---"
systemctl is-active device-gateway.service > /dev/null 2>&1 \
  && ok "device-gateway.service is active" \
  || fail "device-gateway.service is NOT running — run: systemctl start device-gateway"

ss -tlnp | grep -q ":4100" \
  && ok "Port 4100 (gRPC) is listening" \
  || fail "Port 4100 NOT listening"

ss -tlnp | grep -q ":51211" \
  && ok "Port 51211 (device TCP) is listening" \
  || info "Port 51211 not yet open (reader not connected)"

echo ""
echo "--- Docker Containers ---"
for svc in expo-fr-mongo expo-fr-backend expo-fr-gsdk-sidecar expo-fr-frontend; do
  STATUS=$(docker inspect "$svc" --format '{{.State.Status}}' 2>/dev/null)
  HEALTH=$(docker inspect "$svc" --format '{{.State.Health.Status}}' 2>/dev/null)
  if [ "$STATUS" = "running" ]; then
    [ "$HEALTH" = "healthy" ] || [ -z "$HEALTH" ] \
      && ok "$svc: running ($HEALTH)" \
      || fail "$svc: running but health=$HEALTH"
  else
    fail "$svc: status=$STATUS"
  fi
done

echo ""
echo "--- Sidecar SSL Config ---"
HEALTH=$(curl -s http://localhost:4500/health 2>/dev/null)
if echo "$HEALTH" | grep -q '"ok":true'; then
  USE_SSL=$(echo "$HEALTH" | python3 -c "import sys,json; h=json.load(sys.stdin); print(h['gsdk']['useSSL'])" 2>/dev/null)
  GATEWAY=$(echo "$HEALTH" | python3 -c "import sys,json; h=json.load(sys.stdin); print(h['gsdk']['gateway'])" 2>/dev/null)
  ERROR=$(echo "$HEALTH" | python3 -c "import sys,json; h=json.load(sys.stdin); print(h['gsdk']['error'])" 2>/dev/null)
  ok "Sidecar healthy — gateway=$GATEWAY useSSL=$USE_SSL"
  [ "$ERROR" = "None" ] && ok "Sidecar gRPC error: none" || fail "Sidecar gRPC error: $ERROR"
else
  fail "Sidecar health check failed"
fi

echo ""
echo "--- Device Connection Test ---"
RESULT=$(curl -s -X POST http://localhost:4500/devices/test \
  -H "Content-Type: application/json" \
  -d '{"deviceIP":"192.168.0.100","devicePort":51211}' 2>/dev/null)
if echo "$RESULT" | grep -q '"ok":true'; then
  COUNT=$(echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(len(r.get('devices',[])))" 2>/dev/null)
  [ "$COUNT" -gt 0 ] \
    && ok "Gateway connected — $COUNT device(s) found (Suprema reader is online)" \
    || info "Gateway reachable but 0 devices — reader may not be connected yet"
else
  ERR=$(echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('error','?')[:80])" 2>/dev/null)
  fail "Device test failed: $ERR"
fi

echo ""
echo "================================================="
echo " Result: $PASS passed, $FAIL failed"
echo "================================================="
[ "$FAIL" -eq 0 ] && echo " ALL GOOD" && exit 0 || echo " ACTION REQUIRED (see [!!] above)" && exit 1
