#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Expo-City Dubai FR - Production Installation Script
# Standalone, bulletproof deployment with systemd integration
# ═══════════════════════════════════════════════════════════════════════════

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="/opt/expo-fr"
REPO_URL="https://github.com/tariq5024-blip/EXPO-CITY-DUBAI-FR.git"

echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Expo-City Dubai FR - Production Installation${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo ""

# Check root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}Please run as root: sudo ./install-production.sh${NC}"
    exit 1
fi

# Step 1: Install Docker
echo -e "${YELLOW}🔧 Step 1: Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}   ✓ Docker installed${NC}"
else
    echo -e "${GREEN}   ✓ Docker already installed${NC}"
fi

# Add current user to docker group
USER=${SUDO_USER:-$USER}
if [ -n "$USER" ] && [ "$USER" != "root" ]; then
    usermod -aG docker "$USER" || true
fi

# Step 2: Install Docker Compose Plugin
echo -e "${YELLOW}🔧 Step 2: Installing Docker Compose Plugin...${NC}"
if ! docker compose version &> /dev/null; then
    apt-get update
    apt-get install -y docker-compose-plugin
    echo -e "${GREEN}   ✓ Docker Compose plugin installed${NC}"
else
    echo -e "${GREEN}   ✓ Docker Compose plugin already installed${NC}"
fi

# Step 3: Create installation directory
echo -e "${YELLOW}📁 Step 3: Creating installation directory...${NC}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data/visitor-qr-codes"
mkdir -p "$INSTALL_DIR/gateway-runtime/cert"

# Step 4: Clone or update repository
echo -e "${YELLOW}📥 Step 4: Downloading application...${NC}"
if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard origin/main
    echo -e "${GREEN}   ✓ Updated existing installation${NC}"
else
    git clone "$REPO_URL" "$INSTALL_DIR"
    echo -e "${GREEN}   ✓ Cloned repository${NC}"
fi

# Step 5: Setup environment
echo -e "${YELLOW}⚙️  Step 5: Configuring environment...${NC}"
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
    cp .env.example .env
    
    # Detect host IP for GSDK_GATEWAY
    HOST_IP=$(hostname -I | awk '{print $1}')
    sed -i "s/GSDK_GATEWAY=127.0.0.1:4100/GSDK_GATEWAY=$HOST_IP:4100/" .env
    sed -i "s|APP_BASE_URL=http://localhost:4000|APP_BASE_URL=http://$HOST_IP:4000|" .env
    
    echo -e "${YELLOW}   ⚠️  Please edit $INSTALL_DIR/.env with your settings:${NC}"
    echo -e "      - GSDK_GATEWAY (currently set to $HOST_IP:4100)"
    echo -e "      - APP_BASE_URL (currently set to http://$HOST_IP:4000)"
    echo -e "      - JWT_SECRET (generate strong secret)"
    echo -e "      - ADMIN_PASS (set strong password)"
    echo ""
fi

# Step 6: Build and start containers
echo -e "${YELLOW}🐳 Step 6: Building containers...${NC}"
cd "$INSTALL_DIR"
docker compose build --no-cache

# Step 7: Install systemd service
echo -e "${YELLOW}🔌 Step 7: Installing systemd service...${NC}"
cp "$INSTALL_DIR/expo-fr.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable expo-fr.service

# Step 8: Start services
echo -e "${YELLOW}🚀 Step 8: Starting services...${NC}"
systemctl start expo-fr.service

# Wait for startup
sleep 20

# Step 9: Health check
echo -e "${YELLOW}✅ Step 9: Running health checks...${NC}"
HEALTH=$(curl -s http://localhost:4000/api/ready 2>/dev/null || echo "fail")

if [ "$HEALTH" == "fail" ]; then
    echo -e "${RED}   ✗ Health check failed${NC}"
    echo -e "${YELLOW}   Check logs: journalctl -u expo-fr -f${NC}"
    exit 1
else
    echo -e "${GREEN}   ✓ All services healthy${NC}"
fi

# Step 10: Summary
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Installation Complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}📊 Service Status:${NC}"
systemctl status expo-fr --no-pager | grep -E "(Active|Loaded)"
echo ""
echo -e "${BLUE}🌐 Access URLs:${NC}"
echo -e "   Web UI:    http://$HOST_IP:5173"
echo -e "   API:       http://$HOST_IP:4000"
echo -e "   Health:    http://$HOST_IP:4000/api/health"
echo ""
echo -e "${BLUE}🔧 Management Commands:${NC}"
echo -e "   Start:     sudo systemctl start expo-fr"
echo -e "   Stop:      sudo systemctl stop expo-fr"
echo -e "   Restart:   sudo systemctl restart expo-fr"
echo -e "   Status:    sudo systemctl status expo-fr"
echo -e "   Logs:      sudo journalctl -u expo-fr -f"
echo -e "   Compose:   cd $INSTALL_DIR && docker compose logs -f"
echo ""
echo -e "${BLUE}📁 Installation Directory: $INSTALL_DIR${NC}"
echo -e "${BLUE}📁 Configuration File:   $INSTALL_DIR/.env${NC}"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: Edit $INSTALL_DIR/.env and set:${NC}"
echo -e "   - Strong JWT_SECRET (min 32 characters)"
echo -e "   - Strong ADMIN_PASS (min 12 characters)"
echo -e "   - Correct GSDK_GATEWAY IP address"
echo ""
echo -e "${GREEN}The application will auto-start on boot!${NC}"
echo ""
