#!/bin/bash
# Start gateway
cd ~/Expo-FR/gateway-runtime
nohup bash start-gateway.sh >> gateway.out 2>&1 &

# Start Docker
cd ~/Expo-FR
docker compose up -d

# Start auto-sync
sleep 10
nohup bash ~/Expo-FR/auto-sync.sh &

# Start watchdog
sleep 15
nohup bash ~/Expo-FR/watchdog.sh >> ~/Expo-FR/watchdog.log 2>&1 &
