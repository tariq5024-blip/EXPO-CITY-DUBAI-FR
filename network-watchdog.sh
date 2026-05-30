#!/bin/bash
# Network Watchdog - Monitors ethernet connection and maintains static IP
# Run this as a systemd service or cron job for automatic recovery

INTERFACE="enp0s31f6"
STATIC_IP="192.168.0.200/24"
DEVICE_IP="192.168.0.100"
LOG_FILE="/var/log/network-watchdog.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Check if ethernet cable is connected (has carrier)
check_cable() {
    ip link show "$INTERFACE" 2>/dev/null | grep -q "state UP"
    return $?
}

# Check if static IP is configured
check_ip() {
    ip addr show "$INTERFACE" 2>/dev/null | grep -q "inet 192.168.0.200"
    return $?
}

# Check if device is reachable
check_device() {
    ping -c 1 -W 2 "$DEVICE_IP" >/dev/null 2>&1
    return $?
}

# Apply static IP configuration
apply_static_ip() {
    log "Applying static IP $STATIC_IP to $INTERFACE"
    sudo ip addr flush dev "$INTERFACE" 2>/dev/null
    sudo ip addr add "$STATIC_IP" dev "$INTERFACE"
    sudo ip link set "$INTERFACE" up
}

# Main watchdog logic
watchdog() {
    log "Network watchdog started"
    
    CABLE_WAS_CONNECTED=true
    
    while true; do
        if check_cable; then
            # Cable is connected
            if [ "$CABLE_WAS_CONNECTED" = false ]; then
                log "Cable connected - checking IP configuration"
                CABLE_WAS_CONNECTED=true
            fi
            
            # Ensure static IP is set
            if ! check_ip; then
                log "Static IP not configured - applying now"
                apply_static_ip
                sleep 2
            fi
            
            # Check if device is reachable
            if ! check_device; then
                log "WARNING: Device $DEVICE_IP not reachable"
                # Try to restart gateway service if device not responding
                if systemctl is-active device-gateway.service >/dev/null 2>&1; then
                    log "Restarting device-gateway service to re-establish connection"
                    sudo systemctl restart device-gateway.service
                    sleep 5
                fi
            fi
        else
            # Cable disconnected
            if [ "$CABLE_WAS_CONNECTED" = true ]; then
                log "WARNING: Ethernet cable disconnected from $INTERFACE"
                CABLE_WAS_CONNECTED=false
            fi
        fi
        
        # Check every 5 seconds
        sleep 5
    done
}

# One-time fix command
fix_now() {
    log "Running immediate network fix"
    
    echo "1. Checking cable connection..."
    if check_cable; then
        echo "   Cable: CONNECTED"
    else
        echo "   Cable: DISCONNECTED - Please connect ethernet cable!"
        return 1
    fi
    
    echo "2. Checking IP configuration..."
    if check_ip; then
        echo "   IP: Already configured (192.168.0.200)"
    else
        echo "   IP: Not configured - applying static IP..."
        apply_static_ip
    fi
    
    echo "3. Testing device connectivity..."
    if check_device; then
        echo "   Device: REACHABLE (192.168.0.100)"
    else
        echo "   Device: NOT REACHABLE"
    fi
    
    echo "4. Checking gateway service..."
    if systemctl is-active device-gateway.service >/dev/null 2>&1; then
        echo "   Gateway: Running"
    else
        echo "   Gateway: NOT RUNNING - Starting..."
        sudo systemctl start device-gateway.service
    fi
    
    echo ""
    echo "5. Running gateway health check..."
    cd ~/EXPO-CITY-DUBAI-FR && bash gateway-runtime/check-gateway.sh | tail -10
}

# Command line handling
case "$1" in
    daemon)
        watchdog
        ;;
    fix)
        fix_now
        ;;
    status)
        echo "=== Network Watchdog Status ==="
        echo "Interface: $INTERFACE"
        echo "Cable: $([ check_cable ] && echo 'CONNECTED' || echo 'DISCONNECTED')"
        echo "IP: $([ check_ip ] && echo 'CONFIGURED (192.168.0.200)' || echo 'NOT CONFIGURED')"
        echo "Device: $([ check_device ] && echo 'REACHABLE' || echo 'NOT REACHABLE')"
        echo ""
        echo "Interface Details:"
        ip addr show "$INTERFACE" 2>/dev/null | grep -E "(state|inet)" || echo "Interface not found"
        ;;
    *)
        echo "Network Watchdog for Suprema Reader Connection"
        echo ""
        echo "Usage:"
        echo "  $0 fix      - Fix network connection now (one-time)"
        echo "  $0 daemon   - Run continuous monitoring (use with systemd)"
        echo "  $0 status   - Check current network status"
        echo ""
        echo "To install as systemd service:"
        echo "  sudo cp $0 /usr/local/bin/"
        echo "  sudo nano /etc/systemd/system/network-watchdog.service"
        echo "  sudo systemctl enable network-watchdog"
        echo "  sudo systemctl start network-watchdog"
        ;;
esac
