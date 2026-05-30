#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Expo-City Dubai FR - Desktop Launcher
# Starts all services, opens browser, stops services when browser closes
# ═══════════════════════════════════════════════════════════════════════════

INSTALL_DIR="/opt/expo-fr"
LOG_FILE="/tmp/expo-fr-launcher.log"
APP_URL="http://localhost:5173"
API_URL="http://localhost:4000/api/ready"

# Logging
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Check if already running
check_running() {
    if docker compose -f "$INSTALL_DIR/docker-compose.yml" ps | grep -q "Up"; then
        return 0
    fi
    return 1
}

# Wait for API to be ready
wait_for_api() {
    log "Waiting for API to be ready..."
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if curl -s "$API_URL" > /dev/null 2>&1; then
            log "✓ API is ready"
            return 0
        fi
        log "  Attempt $attempt/$max_attempts..."
        sleep 2
        ((attempt++))
    done
    
    log "✗ API failed to start within timeout"
    return 1
}

# Main function
main() {
    log "=== Expo-City Dubai FR Launcher ==="
    
    # Check Docker
    if ! docker info > /dev/null 2>&1; then
        log "ERROR: Docker not running. Please start Docker first."
        notify-send "Expo FR" "Docker not running. Please start Docker." --icon=error
        exit 1
    fi
    
    cd "$INSTALL_DIR" || exit 1
    
    # Start services if not already running
    if ! check_running; then
        log "Starting Expo FR services..."
        notify-send "Expo FR" "Starting services..." --icon=dialog-information
        
        docker compose up -d
        
        if ! wait_for_api; then
            log "ERROR: Failed to start services"
            notify-send "Expo FR" "Failed to start services. Check logs." --icon=error
            docker compose logs --tail 50
            exit 1
        fi
        
        log "✓ Services started"
    else
        log "Services already running"
    fi
    
    # Open browser
    log "Opening browser: $APP_URL"
    notify-send "Expo FR" "Opening application..." --icon=dialog-information
    
    # Try different browsers
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
    
    log "Browser started (PID: $BROWSER_PID)"
    
    # Wait for browser to close
    log "Waiting for browser to close..."
    
    # Monitor browser process
    while kill -0 $BROWSER_PID 2>/dev/null; do
        sleep 5
    done
    
    log "Browser closed, stopping services..."
    notify-send "Expo FR" "Stopping services..." --icon=dialog-information
    
    # Stop services
    docker compose down
    
    log "✓ Services stopped"
    log "=== Session ended ==="
    
    # Show notification
    notify-send "Expo FR" "Application stopped" --icon=dialog-information
}

# Handle script termination
cleanup() {
    log "Received termination signal, cleaning up..."
    cd "$INSTALL_DIR" && docker compose down 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Run main
main
