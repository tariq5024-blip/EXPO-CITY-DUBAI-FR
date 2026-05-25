#!/bin/bash
# Renew self-signed TLS certs for the Suprema device gateway.
# Run this when certs expire or after re-installing the gateway binary.
# Usage: sudo bash gateway-runtime/renew-certs.sh

set -e
CERT_DIR="$(cd "$(dirname "$0")/cert" && pwd)"
echo "[renew-certs] Writing to: $CERT_DIR"

# CA key + cert (10 years)
openssl genrsa -out "$CERT_DIR/ca_key.pem" 2048 2>/dev/null
openssl req -new -x509 -key "$CERT_DIR/ca_key.pem" -out "$CERT_DIR/ca.crt" -days 3650 \
  -subj "/C=AE/O=Suprema/CN=Suprema-CA" 2>/dev/null

# Server key + CSR
openssl genrsa -out "$CERT_DIR/server_key.pem" 2048 2>/dev/null
openssl req -new -key "$CERT_DIR/server_key.pem" -out "$CERT_DIR/server.csr" \
  -subj "/C=AE/O=Suprema/CN=gateway.local" 2>/dev/null

# SAN config
cat > /tmp/gw_san.ext << 'EOF'
[req]
req_extensions = v3_req
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
DNS.2 = gateway.local
DNS.3 = host.docker.internal
IP.1 = 127.0.0.1
IP.2 = 192.168.0.200
EOF

# Sign server cert (5 years)
openssl x509 -req -in "$CERT_DIR/server.csr" -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca_key.pem" -CAcreateserial -out "$CERT_DIR/server.crt" \
  -days 1825 -extensions v3_req -extfile /tmp/gw_san.ext 2>/dev/null

rm -f "$CERT_DIR/server.csr" /tmp/gw_san.ext

# Verify
openssl verify -CAfile "$CERT_DIR/ca.crt" "$CERT_DIR/server.crt" > /dev/null
echo "[renew-certs] Certs OK — valid until: $(openssl x509 -in "$CERT_DIR/server.crt" -noout -enddate | cut -d= -f2)"

echo "[renew-certs] Restarting device-gateway service..."
systemctl restart device-gateway.service
sleep 3
systemctl is-active device-gateway.service && echo "[renew-certs] Gateway running on port 4100"

echo ""
echo "[renew-certs] IMPORTANT: Also force-recreate Docker containers to pick up new ca.crt:"
echo "  docker compose up -d --force-recreate gsdk-sidecar backend"
