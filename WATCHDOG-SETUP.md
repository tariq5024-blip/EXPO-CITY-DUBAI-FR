# Enhanced Watchdog Configuration

This setup ensures automatic detection and recovery from network connectivity issues.

## Quick Apply - Run These Commands

```bash
# 1. Install network watchdog
sudo cp ~/EXPO-CITY-DUBAI-FR/network-watchdog.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/network-watchdog.sh
sudo cp ~/EXPO-CITY-DUBAI-FR/network-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable network-watchdog
sudo systemctl start network-watchdog

# 2. Make static IP permanent
sudo nmcli connection add type ethernet ifname enp0s31f6 con-name "Suprema-Ethernet" \
  ipv4.method manual ipv4.addresses 192.168.0.200/24 \
  ipv4.gateway 192.168.0.1 ipv4.dns 8.8.8.8 \
  connection.autoconnect yes connection.autoconnect-priority 100

# 3. Verify
/usr/local/bin/network-watchdog.sh status
sudo systemctl status network-watchdog
```

## What This Prevents

| Problem | Detection | Auto-Recovery |
|---------|-----------|---------------|
| Ethernet cable disconnected | 5 seconds | Auto-reapply IP when reconnected |
| Device offline (network issue) | 15 seconds | SetAcceptFilter + health refresh |
| Gateway service crash | 10 seconds | Event pull recovery |
| IP lost on reboot | Immediate | Permanent nmcli connection |

## Monitoring

```bash
# Watch network watchdog logs
sudo journalctl -u network-watchdog -f

# Check status anytime
/usr/local/bin/network-watchdog.sh status

# Full system health
bash ~/EXPO-CITY-DUBAI-FR/gateway-runtime/check-gateway.sh
```
