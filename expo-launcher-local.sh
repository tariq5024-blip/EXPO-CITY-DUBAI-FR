#!/bin/bash
# Expo-City Dubai FR - Local Launcher
INSTALL_DIR="/home/test/EXPO-CITY-DUBAI-FR"
LOG_FILE="/tmp/expo-fr-launcher.log"
APP_URL="http://localhost:5173"
API_URL="http://localhost:4000/api/ready"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Check Docker
if ! docker info > /dev/null 2>&1; then
    notify-send "Expo FR" "Docker not running. Please start Docker." --icon=error
    exit 1
fi

cd "$INSTALL_DIR" || exit 1

# Check if already running
if ! docker compose ps | grep -q "Up"; then
    log "Starting services..."
    notify-send "Expo FR" "Starting services..." --icon=dialog-information
    
    docker compose up -d
    
    # Wait for API
    for i in {1..30}; do
        if curl -s "$API_URL" > /dev/null 2>&1; then
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
    google-chrome --app="$APP_URL" --start-maximized &
    BROWSER_PID=$!
elif command -v chromium-browser &> /dev/null; then
    chromium-browser --app="$APP_URL" --start-maximized &
    BROWSER_PID=$!
elif command -v firefox &> /dev/null; then
    firefox "$APP_URL" &
    BROWSER_PID=$!
else
    xdg-open "$APP_URL" &
    BROWSER_PID=$!
fi

# Wait for browser close
while kill -0 $BROWSER_PID 2>/dev/null; do
    sleep 5
done

log "Browser closed, stopping services"
notify-send "Expo FR" "Stopping services..." --icon=dialog-information
docker compose down

log "Services stopped"
notify-send "Expo FR" "Application stopped" --icon=dialog-information
