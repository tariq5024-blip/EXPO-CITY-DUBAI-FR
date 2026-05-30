#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Expo-City Dubai FR - Desktop Setup for Local Development
# ═══════════════════════════════════════════════════════════════════════════

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Get current directory
CURRENT_DIR="$(pwd)"
DESKTOP_DIR="$HOME/Desktop"
APP_NAME="Expo-City-FR"

echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Expo-City Dubai FR - Desktop Icon Setup${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}ERROR: Please run this script from the EXPO-CITY-DUBAI-FR directory${NC}"
    exit 1
fi

# Make scripts executable
echo -e "${YELLOW}🔧 Making scripts executable...${NC}"
chmod +x "$CURRENT_DIR/expo-launcher.sh"
chmod +x "$CURRENT_DIR/install-production.sh"
chmod +x "$CURRENT_DIR/install-desktop-icon.sh"

# Create local launcher script
echo -e "${YELLOW}📝 Creating local launcher...${NC}"
tee "$CURRENT_DIR/expo-launcher-local.sh" > /dev/null << EOF
#!/bin/bash
# Expo-City Dubai FR - Local Launcher
INSTALL_DIR="$CURRENT_DIR"
LOG_FILE="/tmp/expo-fr-launcher.log"
APP_URL="http://localhost:5173"
API_URL="http://localhost:4000/api/ready"

log() {
    echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$1" | tee -a "\$LOG_FILE"
}

# Check Docker
if ! docker info > /dev/null 2>&1; then
    notify-send "Expo FR" "Docker not running. Please start Docker." --icon=error
    exit 1
fi

cd "\$INSTALL_DIR" || exit 1

# Check if already running
if ! docker compose ps | grep -q "Up"; then
    log "Starting services..."
    notify-send "Expo FR" "Starting services..." --icon=dialog-information
    
    docker compose up -d
    
    # Wait for API
    for i in {1..30}; do
        if curl -s "\$API_URL" > /dev/null 2>&1; then
            log "API ready"
            break
        fi
        sleep 2
    done
else
    log "Services already running"
fi

# Open browser
log "Opening browser"
notify-send "Expo FR" "Opening application..." --icon=dialog-information

if command -v google-chrome &> /dev/null; then
    google-chrome --app="\$APP_URL" --start-maximized &
    BROWSER_PID=\$!
elif command -v chromium-browser &> /dev/null; then
    chromium-browser --app="\$APP_URL" --start-maximized &
    BROWSER_PID=\$!
elif command -v firefox &> /dev/null; then
    firefox "\$APP_URL" &
    BROWSER_PID=\$!
else
    xdg-open "\$APP_URL" &
    BROWSER_PID=\$!
fi

# Wait for browser close
while kill -0 \$BROWSER_PID 2>/dev/null; do
    sleep 5
done

log "Browser closed, stopping services"
notify-send "Expo FR" "Stopping services..." --icon=dialog-information
docker compose down

log "Services stopped"
notify-send "Expo FR" "Application stopped" --icon=dialog-information
EOF

chmod +x "$CURRENT_DIR/expo-launcher-local.sh"

# Create desktop entry
echo -e "${YELLOW}🖥️  Creating desktop shortcut...${NC}"

# Create icon
ICON_PATH="$CURRENT_DIR/icon.svg"
if command -v convert &> /dev/null && [ -f "$CURRENT_DIR/icon.svg" ]; then
    convert "$CURRENT_DIR/icon.svg" "$CURRENT_DIR/icon.png" 2>/dev/null || true
    [ -f "$CURRENT_DIR/icon.png" ] && ICON_PATH="$CURRENT_DIR/icon.png"
fi

# Create .desktop file
tee "$CURRENT_DIR/$APP_NAME.desktop" > /dev/null << EOF
[Desktop Entry]
Name=Expo-City Dubai FR
Comment=Face Recognition Access Control System
Exec=$CURRENT_DIR/expo-launcher-local.sh
Type=Application
Terminal=true
Icon=$ICON_PATH
Categories=System;Security;
StartupNotify=true
StartupWMClass=Expo-City-FR
Keywords=face;recognition;access;control;suprema;
Name[en]=Expo-City Dubai FR
Path=$CURRENT_DIR
EOF

chmod +x "$CURRENT_DIR/$APP_NAME.desktop"

# Copy to desktop
mkdir -p "$DESKTOP_DIR"
cp "$CURRENT_DIR/$APP_NAME.desktop" "$DESKTOP_DIR/"
chmod +x "$DESKTOP_DIR/$APP_NAME.desktop"

# Trust the desktop file (for GNOME)
if command -v gio &> /dev/null; then
    gio set "$DESKTOP_DIR/$APP_NAME.desktop" metadata::trusted true 2>/dev/null || true
fi

# Add to applications menu
sudo cp "$CURRENT_DIR/$APP_NAME.desktop" /usr/share/applications/ 2>/dev/null || echo "Could not add to applications menu (needs sudo)"

# Setup systemd service for auto-start on boot
echo -e "${YELLOW}🔌 Setting up auto-start on boot...${NC}"

sudo tee /etc/systemd/system/expo-fr-local.service > /dev/null << EOF
[Unit]
Description=Expo-City Dubai FR - Local Development
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$CURRENT_DIR

# Start services
ExecStart=/usr/bin/docker compose -f $CURRENT_DIR/docker-compose.yml up -d --remove-orphans

# Stop services
ExecStop=/usr/bin/docker compose -f $CURRENT_DIR/docker-compose.yml down

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable expo-fr-local.service

# Summary
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Desktop Icon Setup Complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}🖥️  Desktop Icon:${NC}"
echo -e "   Location: $DESKTOP_DIR/$APP_NAME.desktop"
echo -e "   ${YELLOW}Double-click to start!${NC}"
echo ""
echo -e "${BLUE}🚀 How it works:${NC}"
echo -e "   1. Double-click desktop icon"
echo -e "   2. Terminal opens and starts Docker services"
echo -e "   3. Browser opens automatically at http://localhost:5173"
echo -e "   4. ${YELLOW}Close browser → all services stop automatically${NC}"
echo ""
echo -e "${BLUE}🔌 Auto-start on boot:${NC}"
echo -e "   Enabled: sudo systemctl enable expo-fr-local"
echo -e "   Status:  sudo systemctl status expo-fr-local"
echo ""
echo -e "${BLUE}📂 Current Directory:${NC}"
echo -e "   $CURRENT_DIR"
echo ""
echo -e "${BLUE}📊 Management Commands:${NC}"
echo -e "   Start:    Double-click desktop icon"
echo -e "   Stop:     Close browser window"
echo -e "   Logs:     tail -f /tmp/expo-fr-launcher.log"
echo -e "   Manual:   docker compose up -d | docker compose down"
echo ""
echo -e "${GREEN}Done! You can now:${NC}"
echo -e "   1. Close Windsurf"
echo -e "   2. Double-click 'Expo-City Dubai FR' on your desktop"
echo -e "   3. Application will start and open in browser"
echo ""
