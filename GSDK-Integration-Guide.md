# Suprema G-SDK 1.7.2 — Complete Integration Guide

## Overview

The Suprema G-SDK (Gateway SDK) is the official server-side API that allows this application to communicate with all Suprema biometric devices on your network. It handles device connections, user enrollment, access event streams, and door relay control.

**Architecture:**
```
Your Server (Node.js)
    ↕  G-SDK 1.7.2
BioStation 3 / FaceStation F2 / BioEntry W3 / ...
```

---

## 1. Installation

### Prerequisites
- Node.js 18 or higher
- MongoDB 7.0
- Ubuntu 22.04 LTS (recommended) or Windows Server 2022
- Network access to Suprema devices on port 51211 (or 51212 for SSL)

### Install G-SDK npm package
```bash
npm install @supremainc/g-sdk
```

### Directory structure
```
project/
├── server.js
├── services/
│   └── gsdk.js          ← G-SDK service layer
├── config/
│   └── gsdk.config.js   ← Connection settings
├── certs/
│   ├── ca.crt           ← Certificate authority
│   ├── server.crt       ← Server certificate
│   └── server.key       ← Server private key
```

---

## 2. Connection Configuration

### config/gsdk.config.js
```javascript
module.exports = {
  // G-SDK gateway host (same machine = 127.0.0.1)
  host:    process.env.GSDK_HOST    || "127.0.0.1",
  port:    parseInt(process.env.GSDK_PORT || "4000"),
  useSSL:  process.env.GSDK_SSL     === "true",

  // SSL certificate paths (required if useSSL = true)
  caCert:     "./certs/ca.crt",
  serverCert: "./certs/server.crt",
  serverKey:  "./certs/server.key",

  // Device connection settings
  devicePort:    51211,   // 51212 for SSL connections
  deviceSSL:     true,
  connectTimeout: 5000,   // ms

  // Event polling
  eventPollMs:   3500,

  // Reconnect on failure
  reconnect:     true,
  reconnectDelay: 3000,
};
```

---

## 3. Core G-SDK Service

### services/gsdk.js
```javascript
"use strict";
const { GatewayClient, DeviceClient, UserClient, EventClient } = require("@supremainc/g-sdk");
const config = require("../config/gsdk.config");
const logger  = require("../utils/logger");

class GsdkService {
  constructor() {
    this.gateway    = null;
    this.devices    = new Map();   // deviceId → DeviceClient
    this.simulation = process.env.GSDK_SIMULATION === "true";
    this.eventCB    = null;
  }

  // ── Connect to G-SDK gateway ──────────────────────────────────────
  async init() {
    if (this.simulation) {
      logger.info("[G-SDK] Simulation mode — no real devices needed");
      return;
    }
    this.gateway = new GatewayClient({
      host:    config.host,
      port:    config.port,
      useSSL:  config.useSSL,
      caCert:  config.caCert,
    });
    await this.gateway.connect();
    logger.info(`[G-SDK] Gateway connected: ${config.host}:${config.port}`);
  }

  // ── Connect a single device ───────────────────────────────────────
  async connectDevice(deviceId, ip, port = 51211, useSSL = true) {
    if (this.simulation) return { ok: true, simulated: true };
    try {
      const dc = new DeviceClient({
        gateway:  this.gateway,
        ip:       ip,
        port:     port,
        useSSL:   useSSL,
        timeout:  config.connectTimeout,
      });
      const info = await dc.connect();
      this.devices.set(deviceId, dc);
      logger.info(`[G-SDK] Device ${deviceId} connected — ${info.model} fw${info.firmwareVersion}`);
      return { ok: true, ...info };
    } catch (err) {
      logger.error(`[G-SDK] Device ${deviceId} connect failed: ${err.message}`);
      throw err;
    }
  }

  // ── Disconnect a device ───────────────────────────────────────────
  async disconnectDevice(deviceId) {
    const dc = this.devices.get(deviceId);
    if (dc) { await dc.disconnect(); this.devices.delete(deviceId); }
  }

  // ── Get device info ───────────────────────────────────────────────
  async getDeviceInfo(deviceId) {
    if (this.simulation) return { model:"BioStation 3 (BS3-DB)", firmware:"v3.5.2", serial:"SIM-001" };
    const dc = this.devices.get(deviceId);
    if (!dc) throw new Error(`Device ${deviceId} not connected`);
    return dc.getDeviceInfo();
  }

  // ── Enroll a user's face ──────────────────────────────────────────
  async enrollFace(deviceId, userId, options = {}) {
    if (this.simulation) {
      logger.info(`[G-SDK:SIM] enrollFace userId=${userId} on ${deviceId}`);
      return { ok: true, templateId: `TPL-${userId}-${Date.now()}` };
    }
    const dc = this.devices.get(deviceId);
    if (!dc) throw new Error(`Device ${deviceId} not connected`);
    const uc = new UserClient(dc);
    return uc.enrollFace({
      userId:         userId,
      authMode:       options.authMode     || 0x00,  // Face Only
      userGroup:      options.userGroup    || 1,
      matchThreshold: options.threshold    || 0.50,
      antiSpoofing:   options.antiSpoof    ?? true,
      npuOptimised:   true,
    });
  }

  // ── Enroll a card ─────────────────────────────────────────────────
  async enrollCard(deviceId, userId, cardType, cardData) {
    if (this.simulation) return { ok: true };
    const dc = this.devices.get(deviceId);
    const uc = new UserClient(dc);
    return uc.enrollCard({ userId, cardType, cardData });
  }

  // ── Set user auth mode ────────────────────────────────────────────
  async setUserAuthMode(deviceId, userId, authMode) {
    if (this.simulation) return { ok: true };
    const dc = this.devices.get(deviceId);
    const uc = new UserClient(dc);
    return uc.setAuthMode({ userId, authMode });
  }

  // ── Delete user from device ───────────────────────────────────────
  async deleteUser(deviceId, userId) {
    if (this.simulation) return { ok: true };
    const dc = this.devices.get(deviceId);
    const uc = new UserClient(dc);
    return uc.deleteUser({ userId });
  }

  // ── Sync all users to device ──────────────────────────────────────
  async syncUsers(deviceId, users) {
    if (this.simulation) return { ok: true, synced: users.length };
    const dc = this.devices.get(deviceId);
    const uc = new UserClient(dc);
    for (const user of users) {
      await uc.enrollUser(user);
    }
    return { ok: true, synced: users.length };
  }

  // ── Stream access events ──────────────────────────────────────────
  startEventStream(onEvent) {
    this.eventCB = onEvent;
    if (this.simulation) {
      this._startSimEventStream(onEvent);
      return;
    }
    // Real G-SDK event subscription
    for (const [deviceId, dc] of this.devices) {
      const ec = new EventClient(dc);
      ec.on("event", async (evt) => {
        const mapped = this._mapEvent(deviceId, evt);
        await onEvent({ type: "ACCESS_EVENT", data: mapped });
      });
      ec.subscribe();
    }
  }

  // ── Retrieve offline buffered events ─────────────────────────────
  async getOfflineEvents(deviceId) {
    if (this.simulation) return [];
    const dc = this.devices.get(deviceId);
    const ec = new EventClient(dc);
    return ec.getStoredEvents();
  }

  // ── Control door relay ────────────────────────────────────────────
  async unlockDoor(deviceId, doorId, durationMs = 3000) {
    if (this.simulation) return { ok: true };
    const dc = this.devices.get(deviceId);
    return dc.unlockDoor({ doorId, duration: durationMs });
  }

  // ── Lock door relay ───────────────────────────────────────────────
  async lockDoor(deviceId, doorId) {
    if (this.simulation) return { ok: true };
    const dc = this.devices.get(deviceId);
    return dc.lockDoor({ doorId });
  }

  // ── Internal helpers ──────────────────────────────────────────────
  isSimulation() { return this.simulation; }

  _mapEvent(deviceId, evt) {
    return {
      deviceId,
      employeeId:    evt.userId,
      employeeName:  evt.userName || "Unknown",
      gsdkEventCode: evt.eventCode,
      eventType:     evt.eventCode === 0x1000 ? "ACCESS_GRANTED" : "ACCESS_DENIED",
      accessGranted: evt.eventCode === 0x1000,
      authMode:      evt.authMode,
      credential:    evt.credentialType,
      confidence:    evt.matchScore,
      processingMs:  evt.processingTime,
      temperature:   evt.temperature,
      maskDetected:  evt.maskDetected,
      timestamp:     new Date(evt.timestamp * 1000),
    };
  }

  _startSimEventStream(cb) {
    setInterval(() => {
      cb({ type: "ACCESS_EVENT", data: {
        deviceId: "DEV-SIM-001", employeeId: `U${Math.floor(Math.random()*9000)+1000}`,
        employeeName: "Simulated User", accessGranted: Math.random()>0.15,
        authMode: 0x00, confidence: Math.floor(Math.random()*20)+80,
        processingMs: Math.floor(Math.random()*300)+100, temperature: 36.5,
        timestamp: new Date(),
      }});
    }, 3500);
  }

  async disconnect() {
    for (const [id, dc] of this.devices) {
      await dc.disconnect().catch(()=>{});
    }
    if (this.gateway) await this.gateway.disconnect().catch(()=>{});
  }
}

module.exports = new GsdkService();
```

---

## 4. Auth Mode Constants

| Mode ID | Hex    | Description              |
|---------|--------|--------------------------|
| FACE    | 0x00   | Face Only                |
| CARD    | 0x01   | Card Only                |
| PIN     | 0x02   | PIN Only                 |
| F+C     | 0x10   | Face AND Card (2FA)      |
| F+P     | 0x11   | Face AND PIN (2FA)       |
| C+P     | 0x12   | Card AND PIN (2FA)       |
| F+C+P   | 0x20   | Face AND Card AND PIN (3FA) |
| MOBILE  | 0x30   | Mobile BLE/NFC           |
| QR      | 0x40   | QR Code                  |
| BYPASS  | 0xFF   | No authentication        |

---

## 5. Card Type Constants

| Card Type         | Constant               |
|-------------------|------------------------|
| EM4100            | CARD_TYPE_EM4100       |
| MIFARE Classic    | CARD_TYPE_MIFARE       |
| MIFARE Plus       | CARD_TYPE_MIFARE_PLUS  |
| DESFire EV2       | CARD_TYPE_DESFIRE_EV2  |
| DESFire EV3       | CARD_TYPE_DESFIRE_EV3  |
| iCLASS            | CARD_TYPE_ICLASS       |
| HID SEOS          | CARD_TYPE_SEOS         |
| HID Prox          | CARD_TYPE_HID_PROX     |
| FeliCa            | CARD_TYPE_FELICA       |

---

## 6. G-SDK Event Codes (Common)

| Code   | Name                        | Description              |
|--------|-----------------------------|--------------------------|
| 0x1000 | BS2_EVENT_VERIFY_SUCCESS    | Access granted           |
| 0x1001 | BS2_EVENT_IDENTIFY_SUCCESS  | 1:N identification OK    |
| 0x2000 | BS2_EVENT_VERIFY_FAIL       | Access denied            |
| 0x2001 | BS2_EVENT_AUTHENTICATE_FAIL | Auth failure             |
| 0x3000 | BS2_EVENT_ANTI_PASSBACK_FAIL| Anti-passback violation  |
| 0x4000 | BS2_EVENT_DEVICE_CONNECT    | Device connected         |
| 0x4001 | BS2_EVENT_DEVICE_DISCONNECT | Device disconnected      |
| 0x5000 | BS2_EVENT_TAMPER_ON         | Tamper detected          |
| 0x6000 | BS2_EVENT_DOOR_OPENED       | Door opened              |
| 0x6001 | BS2_EVENT_DOOR_CLOSED       | Door closed              |
| 0x7000 | BS2_EVENT_LIVENESS_FAIL     | Liveness (anti-spoof) failed |

---

## 7. SSL Certificate Setup

```bash
# Generate self-signed certificates (development)
mkdir -p ./certs && cd ./certs

# CA
openssl genrsa -out ca.key 2048
openssl req -new -x509 -key ca.key -out ca.crt -days 3650 -subj "/CN=SupremaCA"

# Server cert
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=ACSServer"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 3650

# Set permissions
chmod 600 server.key ca.key
```

---

## 8. Testing the Connection

```bash
# Test from command line
node scripts/testGsdk.js

# Test script (scripts/testGsdk.js)
const gsdk = require("../services/gsdk");
async function test() {
  await gsdk.init();
  const result = await gsdk.connectDevice("TEST-001","192.168.10.100",51211,true);
  console.log("Device info:", result);
  process.exit(0);
}
test().catch(console.error);
```

---

## 9. Environment Variables

```env
GSDK_HOST=127.0.0.1
GSDK_PORT=4000
GSDK_SSL=true
GSDK_CA_CERT=./certs/ca.crt
GSDK_SERVER_CERT=./certs/server.crt
GSDK_SERVER_KEY=./certs/server.key
DEVICE_PORT=51211
DEVICE_SSL=true
GSDK_SIMULATION=false   # set true for demo mode
```

---

## 10. Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| Connection refused | Firewall blocking port | Open port 51211 (TCP) |
| SSL handshake error | Wrong cert | Regenerate and copy certs to ./certs/ |
| User not found | userId mismatch | Confirm userId matches MongoDB _id |
| Face enroll fails | Poor photo quality | Use AI enrollment to pre-screen photos |
| Offline events missing | Buffer disabled | Enable offline buffer in device settings |
| High response time | CPU fallback | Enable NPU-only mode in device settings |
