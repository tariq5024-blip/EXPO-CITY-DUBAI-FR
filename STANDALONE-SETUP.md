# 🖥️ Expo-City Dubai FR - Standalone Setup Guide

This guide sets up the application as a **standalone, bulletproof system** that runs completely independently without any IDE (no Windsurf, no VSCode needed).

## 🎯 What's Included

Everything runs in Docker containers:
- ✅ MongoDB Database
- ✅ Ollama AI Service  
- ✅ Node.js Backend API
- ✅ React Frontend
- ✅ G-SDK Sidecar (Suprema integration)

No host dependencies except Docker itself!

## 🚀 Quick Start (Auto-Install)

```bash
# 1. Download the installer
curl -fsSL https://raw.githubusercontent.com/tariq5024-blip/EXPO-CITY-DUBAI-FR/main/install-production.sh -o install.sh
chmod +x install.sh

# 2. Run as root
sudo ./install.sh

# 3. Edit configuration
sudo nano /opt/expo-fr/.env

# 4. Restart with new config
sudo systemctl restart expo-fr
```

## 🔧 Manual Setup

### Step 1: Install Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Verify
docker version
docker compose version
```

### Step 2: Download Application

```bash
# Create directory
sudo mkdir -p /opt/expo-fr

# Clone repository
cd /opt
sudo git clone https://github.com/tariq5024-blip/EXPO-CITY-DUBAI-FR.git

# Fix ownership
sudo chown -R $USER:$USER /opt/expo-fr
```

### Step 3: Configure Environment

```bash
cd /opt/expo-fr

# Copy example
sudo cp .env.example .env

# IMPORTANT: Edit with your settings
sudo nano .env
```

**Critical settings to change:**
```bash
# Your laptop/server IP where device_gateway runs
GSDK_GATEWAY=192.168.0.200:4100

# TLS settings (match your gateway)
GSDK_USE_SSL=true

# Security - CHANGE THESE!
JWT_SECRET=your-32-char-secret-here-minimum
ADMIN_PASS=your-strong-password-here

# Base URL for QR codes
APP_BASE_URL=http://192.168.0.200:4000
```

### Step 4: Build & Start

```bash
# Build all containers
cd /opt/expo-fr
sudo docker compose build --no-cache

# Start
sudo docker compose up -d

# Verify
curl http://localhost:4000/api/health
```

### Step 5: Auto-Start on Boot

```bash
# Install systemd service
sudo cp /opt/expo-fr/expo-fr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable expo-fr
sudo systemctl start expo-fr

# Install health monitor
sudo cp /opt/expo-fr/health-monitor.sh /opt/expo-fr/
sudo chmod +x /opt/expo-fr/health-monitor.sh
sudo cp /opt/expo-fr/expo-fr-health.service /etc/systemd/system/
sudo cp /opt/expo-fr/expo-fr-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable expo-fr-health.timer
sudo systemctl start expo-fr-health.timer
```

## 🛡️ Bulletproof Features

### 1. Auto-Restart on Boot
```bash
# Systemd handles startup
sudo systemctl status expo-fr
```

### 2. Health Monitoring
- Runs every minute via systemd timer
- Auto-restarts failed containers
- Logs to `/var/log/expo-fr-health.log`

### 3. Container Restart Policy
All containers have `restart: unless-stopped`:
- Auto-restart on crash
- Auto-restart on host reboot

### 4. No Host Dependencies
Everything is in containers:
- No Node.js on host
- No MongoDB on host  
- No G-SDK on host
- Only Docker required

## 📊 Management Commands

```bash
# View status
sudo systemctl status expo-fr

# Start/Stop/Restart
sudo systemctl start expo-fr
sudo systemctl stop expo-fr
sudo systemctl restart expo-fr

# View logs
sudo journalctl -u expo-fr -f
sudo docker compose -f /opt/expo-fr/docker-compose.yml logs -f

# Health check
curl http://localhost:4000/api/health | jq

# View containers
sudo docker ps

# Enter container
sudo docker exec -it expo-fr-backend bash
```

## 🔍 Troubleshooting

### Service Won't Start
```bash
# Check logs
sudo journalctl -u expo-fr -n 100

# Check Docker
sudo docker info

# Manual start for debugging
sudo docker compose -f /opt/expo-fr/docker-compose.yml up
```

### Gateway Connection Issues
```bash
# Test gateway reachability
ping -I enx00e04c360562 192.168.0.100

# Check gateway service
sudo systemctl status device-gateway

# Verify certs
ls -la /opt/expo-fr/gateway-runtime/cert/
```

### Database Issues
```bash
# Reset MongoDB (WARNING: DATA LOSS)
sudo docker compose -f /opt/expo-fr/docker-compose.yml down -v
sudo docker volume rm expo-fr_mongo_data
```

## 🔄 Updates

```bash
# Pull latest
cd /opt/expo-fr
sudo git pull origin main

# Rebuild and restart
sudo docker compose down
sudo docker compose build --no-cache
sudo systemctl restart expo-fr
```

## 🆘 Emergency Recovery

If everything breaks:

```bash
# Nuclear option - full reset
sudo systemctl stop expo-fr
sudo docker compose -f /opt/expo-fr/docker-compose.yml down -v
sudo rm -rf /opt/expo-fr

# Reinstall
sudo ./install-production.sh
```

## 📁 File Locations

| Path | Purpose |
|------|---------|
| `/opt/expo-fr` | Application directory |
| `/opt/expo-fr/.env` | Configuration |
| `/opt/expo-fr/data` | Visitor QR codes, photos |
| `/var/log/expo-fr-health.log` | Health monitor logs |
| `/etc/systemd/system/expo-fr.service` | Main service |
| `/etc/systemd/system/expo-fr-health.service` | Health monitor |

## ✨ Verify Standalone Operation

After setup, verify it works without any IDE:

```bash
# Close all IDEs
# Reboot system
sudo reboot

# After reboot, check (no IDE open!)
curl http://localhost:4000/api/health
curl http://localhost:5173  # Frontend
```

## 🎉 Done!

Your Expo-City Dubai FR system is now:
- ✅ **Fully containerized** - Everything in Docker
- ✅ **Standalone** - No IDE required
- ✅ **Auto-starting** - Boots with system
- ✅ **Self-healing** - Auto-recovery built-in
- ✅ **Production-ready** - Bulletproof deployment
