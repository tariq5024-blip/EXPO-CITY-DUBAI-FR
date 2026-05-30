#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Expo-City Dubai FR - Health Monitor & Auto-Recovery
# Standalone monitoring for bulletproof operation
# ═══════════════════════════════════════════════════════════════════════════

INSTALL_DIR="/opt/expo-fr"
LOG_FILE="/var/log/expo-fr-health.log"
MAX_LOG_SIZE=10485760  # 10MB

# Rotate log if too large
rotate_log() {
    if [ -f "$LOG_FILE" ] && [ $(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0) -gt $MAX_LOG_SIZE ]; then
        mv "$LOG_FILE" "$LOG_FILE.old"
    fi
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Check if Docker is running
check_docker() {
    if ! docker info &>/dev/null; then
        log "ERROR: Docker not running, attempting to start..."
        systemctl start docker || return 1
        sleep 5
    fi
    return 0
}

# Check service health via API
check_api() {
    local response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/api/ready 2>/dev/null)
    if [ "$response" == "200" ]; then
        return 0
    fi
    return 1
}

# Check MongoDB
check_mongo() {
    docker compose -f "$INSTALL_DIR/docker-compose.yml" exec -T mongo mongosh --quiet --eval 'db.adminCommand({ ping: 1 }).ok' 2>/dev/null | grep -q "1"
    return $?
}

# Check GSDK Sidecar
check_sidecar() {
    local response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4500/health 2>/dev/null)
    if [ "$response" == "200" ]; then
        return 0
    fi
    return 1
}

# Main health check
main() {
    rotate_log
    
    cd "$INSTALL_DIR" || exit 1
    
    # Check Docker
    if ! check_docker; then
        log "CRITICAL: Docker failed to start"
        return 1
    fi
    
    # Check if containers are running
    local running_containers=$(docker compose ps -q 2>/dev/null | wc -l)
    if [ "$running_containers" -eq 0 ]; then
        log "WARNING: No containers running, starting services..."
        systemctl restart expo-fr
        sleep 30
    fi
    
    # Check API health
    if ! check_api; then
        log "WARNING: API health check failed"
        
        # Check individual services
        if ! check_mongo; then
            log "ERROR: MongoDB not responding, restarting..."
            docker compose restart mongo
            sleep 10
        fi
        
        if ! check_sidecar; then
            log "ERROR: GSDK Sidecar not responding, restarting..."
            docker compose restart gsdk-sidecar
            sleep 10
        fi
        
        # Restart backend if still failing
        if ! check_api; then
            log "ERROR: Backend unhealthy, restarting..."
            docker compose restart backend
            sleep 15
        fi
    else
        log "INFO: All services healthy"
    fi
    
    # Cleanup old logs
    if [ -f "$LOG_FILE.old" ]; then
        rm -f "$LOG_FILE.old.2" 2>/dev/null
        mv "$LOG_FILE.old" "$LOG_FILE.old.2" 2>/dev/null
    fi
}

# Run main check
main
exit $?
