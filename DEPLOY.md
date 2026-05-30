# 🚀 Expo-City Dubai FR - Deployment Guide

## Quick Start (5 minutes)

```bash
# 1. Clone and enter directory
git clone https://github.com/tariq5024-blip/EXPO-CITY-DUBAI-FR.git
cd EXPO-CITY-DUBAI-FR

# 2. Copy environment file
cp .env.example .env

# 3. Edit .env with your settings (especially GSDK_GATEWAY)
nano .env

# 4. Build and start
docker-compose up -d --build

# 5. Check status
docker-compose ps
curl http://localhost:4000/api/health
```

## 🐳 Docker Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| mongo | mongo:7 | 27017 | Database |
| ollama | ollama/ollama:latest | 11435 | AI/LLM |
| backend | expo-fr-backend (build) | 4000 | API Server |
| frontend | expo-fr-frontend (build) | 5173 | Web UI |
| gsdk-sidecar | expo-fr-gsdk-sidecar (build) | 4500 | Suprema Gateway |

## 🔧 Environment Configuration

### Critical Settings (must configure)

```bash
# Suprema Device Gateway (your laptop IP where device_gateway runs)
GSDK_GATEWAY=192.168.0.200:4100          # or host.docker.internal:4100

# TLS/SSL (match your gateway config)
GSDK_USE_SSL=true
GSDK_TLS_CA=/opt/gateway-cert/ca.crt

# MongoDB (Docker internal)
MONGODB_URI=mongodb://mongo:27017/expo-fr

# Base URL (for QR codes, emails)
APP_BASE_URL=http://192.168.0.200:4000
```

### Device Sync Settings (NEW - Critical for Offline Devices)

```bash
# Enable device sync queue
DEVICE_SYNC_QUEUE_ENABLED=true
DEVICE_SYNC_QUEUE_TICK_MS=30000

# NEW: Unlimited retention for 24h/1week+ offline devices
DEVICE_SYNC_UNLIMITED_RETENTION=true
DEVICE_SYNC_MAX_RETRY_DELAY_MS=3600000  # 1 hour between retries

# NEW: Visitor device sync
DEVICE_REVOKE_ON_VISITOR_REMOVE=true
VISITOR_ENROLLMENT_PUSH_DEVICES=true
```

### Environment Files by Use Case

| File | Use Case |
|------|----------|
| `.env.example` | Standard development |
| `.env.enterprise-r440` | High scale (500+ devices, 6000+ employees) |
| `.env.watchdog` | Network resilience (unstable connections) |

## 📦 Build & Push to GitHub

```bash
# Automated build and push
./build-and-push.sh

# Or manual:
docker-compose build --no-cache
docker-compose up -d
git add -A
git commit -m "Deployment $(date)"
git push origin main
```

## 🏭 Production Deployment

### Step 1: Server Preparation

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### Step 2: Deploy Application

```bash
# Download release
wget https://github.com/tariq5024-blip/EXPO-CITY-DUBAI-FR/releases/latest/download/deploy.tar.gz
tar -xzf deploy.tar.gz
cd EXPO-CITY-DUBAI-FR

# Configure
cp .env.enterprise-r440 .env
nano .env  # Edit settings

# Start
docker-compose up -d

# Verify
docker-compose logs -f backend
```

### Step 3: Systemd Service (Auto-start)

```bash
# Create service file
sudo tee /etc/systemd/system/expo-fr.service << 'EOF'
[Unit]
Description=Expo-City Dubai FR
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/expo-fr
ExecStart=/usr/local/bin/docker-compose up -d --remove-orphans
ExecStop=/usr/local/bin/docker-compose stop
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable expo-fr
sudo systemctl start expo-fr
```

## 🔍 Monitoring & Health Checks

### API Health
```bash
# Check system health
curl http://localhost:4000/api/health | jq

# Check device sync queue
curl http://localhost:4000/api/devices/sync-queue | jq

# Check specific device queue
curl http://localhost:4000/api/devices/{device-id}/sync-queue | jq
```

### Docker Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
docker-compose logs -f gsdk-sidecar
```

### Common Issues

| Issue | Solution |
|-------|----------|
| `Gateway UNAVAILABLE` | Check GSDK_GATEWAY IP, verify device_gateway running |
| `Devices offline` | Check network route: `ping -I enx00e04c360562 192.168.0.100` |
| `Queue not processing` | Check DEVICE_SYNC_QUEUE_ENABLED=true, verify sidecar health |
| `Visitor not enrolling` | Check VISITOR_ENROLLMENT_PUSH_DEVICES=true, verify photo saved |

## 🔄 Updates

```bash
# Pull latest
git pull origin main

# Rebuild
docker-compose down
docker-compose up -d --build

# Verify
docker-compose ps
```

## 🛡️ Security Checklist

- [ ] Change JWT_SECRET (min 32 chars)
- [ ] Change ADMIN_PASS (min 12 chars)
- [ ] Set NODE_ENV=production
- [ ] Configure CORS_ORIGINS
- [ ] Enable firewall (ufw/iptables)
- [ ] Use TLS certificates (not self-signed in production)
- [ ] Regular backups: `docker-compose exec mongo mongodump --out /data/backup`

## 📞 Support

- GitHub Issues: https://github.com/tariq5024-blip/EXPO-CITY-DUBAI-FR/issues
- Documentation: See `*.md` files in repository

## 📊 Performance Tuning

### For 100+ Devices
```bash
DEVICE_EVENT_PULL_CONCURRENCY=50
DEVICE_SYNC_BATCH_SIZE=50
DEVICE_SYNC_QUEUE_TICK_MS=15000
```

### For 1000+ Employees
```bash
MONGODB_MAX_POOL_SIZE=200
FACE_AUTO_REFRESH_BATCH=20
RATE_LIMIT_MAX=3000
```

### For Unstable Networks
```bash
DEVICE_SYNC_UNLIMITED_RETENTION=true
DEVICE_SYNC_MAX_RETRY_DELAY_MS=1800000  # 30 min
SELF_HEALING_ENABLED=true
WATCHDOG_ENABLED=true
```
