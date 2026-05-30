#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Expo-City Dubai FR - Desktop Icon Installation
# Creates desktop shortcut and sets up auto-start on boot
# ═══════════════════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

INSTALL_DIR="/opt/expo-fr"
DESKTOP_DIR="$HOME/Desktop"

echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Expo-City Dubai FR - Desktop Icon Setup${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if installation exists
if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${RED}ERROR: Installation not found at $INSTALL_DIR${NC}"
    echo -e "${YELLOW}Please run install-production.sh first:${NC}"
    echo "sudo ./install-production.sh"
    exit 1
fi

# Create install directory if not exists (for local testing)
if [ ! -d "$INSTALL_DIR" ]; then
    sudo mkdir -p "$INSTALL_DIR"
fi

# Copy launcher script
echo -e "${YELLOW}📋 Setting up launcher script...${NC}"
sudo cp expo-launcher.sh "$INSTALL_DIR/"
sudo chmod +x "$INSTALL_DIR/expo-launcher.sh"

# Copy icon
echo -e "${YELLOW}🎨 Setting up icon...${NC}"
if command -v convert &> /dev/null; then
    # Convert SVG to PNG if ImageMagick is available
    convert icon.svg "$INSTALL_DIR/icon.png" 2>/dev/null || cp icon.svg "$INSTALL_DIR/icon.svg"
else
    # Copy SVG directly
    sudo cp icon.svg "$INSTALL_DIR/icon.svg"
fi

# Update desktop file with correct icon path
echo -e "${YELLOW}🖥️  Creating desktop shortcut...${NC}"
if [ -f "$INSTALL_DIR/icon.png" ]; then
    ICON_PATH="$INSTALL_DIR/icon.png"
else
    ICON_PATH="$INSTALL_DIR/icon.svg"
fi

# Create desktop entry
sudo tee "$INSTALL_DIR/Expo-City-FR.desktop" > /dev/null << EOF
[Desktop Entry]
Name=Expo-City Dubai FR
Comment=Face Recognition Access Control System
Exec=$INSTALL_DIR/expo-launcher.sh
Type=Application
Terminal=true
Icon=$ICON_PATH
Categories=System;Security;
StartupNotify=true
StartupWMClass=Expo-City-FR
Keywords=face;recognition;access;control;suprema;
Name[en]=Expo-City Dubai FR
Name[ar]=إكسبو سيتي دبي FR
EOF

sudo chmod +x "$INSTALL_DIR/Expo-City-FR.desktop"

# Copy to desktop
mkdir -p "$DESKTOP_DIR"
cp "$INSTALL_DIR/Expo-City-FR.desktop" "$DESKTOP_DIR/"
chmod +x "$DESKTOP_DIR/Expo-City-FR.desktop"

# Trust the desktop file (for GNOME)
if command -v gio &> /dev/null; then
    gio set "$DESKTOP_DIR/Expo-City-FR.desktop" metadata::trusted true 2>/dev/null || true
fi

# Add to applications menu
sudo cp "$INSTALL_DIR/Expo-City-FR.desktop" /usr/share/applications/

# Install systemd service for auto-start on boot
echo -e "${YELLOW}🔌 Setting up auto-start on boot...${NC}"
sudo tee /etc/systemd/system/expo-fr.service > /dev/null << 'EOF'
[Unit]
Description=Expo-City Dubai FR - Face Recognition System
Documentation=https://github.com/tariq5024-blip/EXPO-CITY-DUBAI-FR
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/expo-fr
Environment="DOCKER_COMPOSE_VERSION=2"

# Start services
ExecStartPre=-/usr/bin/docker compose down --remove-orphans 2>/dev/null
ExecStart=/usr/bin/docker compose up -d --remove-orphans

# Stop services
ExecStop=/usr/bin/docker compose down

# Reload
ExecReload=/usr/bin/docker compose up -d --remove-orphans

# Timeouts
TimeoutStartSec=5min
TimeoutStopSec=60s

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable expo-fr.service

echo -e "${GREEN}   ✓ Auto-start on boot enabled${NC}"

# Setup complete
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Desktop Icon Setup Complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}🖥️  Desktop Icon:${NC}"
echo -e "   Location: $DESKTOP_DIR/Expo-City-FR.desktop"
echo -e "   ${YELLOW}Double-click to start!${NC}"
echo ""
echo -e "${BLUE}🚀 How it works:${NC}"
echo -e "   1. Double-click desktop icon"
echo -e "   2. Terminal opens and starts services"
echo -e "   3. Browser opens automatically"
echo -e "   4. ${YELLOW}Close browser → all services stop${NC}"
echo ""
echo -e "${BLUE}🔌 Auto-start on boot:${NC}"
echo -e "   Enabled: Services start when laptop boots"
echo -e "   Check: sudo systemctl status expo-fr"
echo ""
echo -e "${BLUE}📊 Management:${NC}"
echo -e "   Start:    Double-click desktop icon"
echo -e "   Stop:     Close browser window"
echo -e "   Logs:     tail -f /tmp/expo-fr-launcher.log"
echo -e "   Service:  sudo systemctl start|stop|restart expo-fr"
echo ""
echo -e "${GREEN}Done! You can now close Windsurf and use the desktop icon.${NC}"
echo ""
