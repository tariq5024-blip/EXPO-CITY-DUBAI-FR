#!/bin/bash
# Configure static IP 192.168.0.200 on ethernet for Suprema device connection

INTERFACE="enp0s31f6"
STATIC_IP="192.168.0.200/24"
GATEWAY="192.168.0.1"

echo "=== Ethernet Static IP Configuration ==="
echo "Interface: $INTERFACE"
echo "Static IP: $STATIC_IP"
echo ""

# Check if interface exists
if ! ip link show "$INTERFACE" &>/dev/null; then
    echo "ERROR: Interface $INTERFACE not found!"
    echo "Available interfaces:"
    ip link show | grep -E "^[0-9]+:" | grep -v "lo:" | awk '{print $2}' | tr -d ':'
    exit 1
fi

# Check cable connection
if ! ip link show "$INTERFACE" | grep -q "state UP"; then
    echo "⚠️  WARNING: Ethernet cable not connected or interface DOWN"
    echo "Please connect ethernet cable to your laptop first!"
    echo ""
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 1
fi

# Remove any existing IP on this interface
sudo ip addr flush dev "$INTERFACE" 2>/dev/null

# Add static IP
sudo ip addr add "$STATIC_IP" dev "$INTERFACE"

# Bring interface up
sudo ip link set "$INTERFACE" up

# Verify
echo ""
echo "=== Configuration Applied ==="
ip addr show "$INTERFACE" | grep "inet "
echo ""
echo "Testing connectivity to device at 192.168.0.100..."
ping -c 3 192.168.0.100

# Update gateway service config if needed
if [ -f /etc/systemd/system/device-gateway.service ]; then
    echo ""
    read -p "Restart device-gateway service? (Y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        sudo systemctl restart device-gateway.service
        sleep 2
        sudo systemctl status device-gateway.service --no-pager
    fi
fi

echo ""
echo "=== Done ==="
echo "To make this permanent (survives reboot), run:"
echo "  sudo nmcli connection add type ethernet ifname $INTERFACE ipv4.method manual ipv4.addresses $STATIC_IP ipv4.gateway $GATEWAY ipv4.dns 8.8.8.8"
