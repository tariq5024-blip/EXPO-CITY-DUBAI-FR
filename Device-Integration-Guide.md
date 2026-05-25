# Suprema Device Integration Guide
## All Supported Models · Connection Guide · Specifications

---

## Supported Devices Overview

All devices below are fully supported via **Suprema G-SDK 1.7.2**.

| Model | Code | Type | Face | Card | PIN | Mobile | NPU | IP65 | PoE+ |
|-------|------|------|------|------|-----|--------|-----|------|------|
| BioStation 3 | BS3 | Face+Card+PIN | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| BioStation A2 Plus | BSA2 | Face+Finger | ✓ | ✓ | ✓ | — | — | ✓ | ✓ |
| FaceStation F2 | FSF2 | Face | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| BioEntry W3 | BEW3 | Card+Face | ✓ | ✓ | ✓ | — | — | ✓ | ✓ |
| BioLite N2 | BLN2 | Card+PIN | — | ✓ | ✓ | — | — | — | — |
| CoreStation | CS | Controller | — | ✓ | ✓ | — | — | — | — |
| XPass 2 | XP2 | Card Reader | — | ✓ | — | — | — | ✓ | ✓ |
| BioStation L2 | BSL2 | Fingerprint | — | ✓ | ✓ | — | — | — | — |

---

## 1. BioStation 3 (BS3)

### The primary device — all features supported

**Key capabilities:**
- AI facial recognition with NPU chip — matching under 0.2 seconds
- Works with masks, glasses, hats, beards (dynamic face templates)
- Liveness / anti-spoof detection on-chip
- 5MP visual + IR cameras
- All contactless credentials: face, RFID, mobile BLE/NFC, QR, barcode
- VoIP intercom
- RTSP video streaming
- IP65 + IK06 rated — indoor and outdoor

**Specifications:**
| Item | Value |
|------|-------|
| CPU | 1.8GHz Quad-Core |
| NPU | Neural Processing Unit |
| Display | 5" IPS Touch (720×1280) |
| Camera | 5MP + IR (face), Wide-angle |
| Face Recognition Speed | < 0.2 seconds |
| Face Users | 30,000 (30K templates) |
| Max Users | 500,000 |
| Log Capacity | 5,000,000 events |
| Card Protocols | MIFARE, DESFire EV1/EV2/EV3, iCLASS, HID SEOS, HID Prox, FeliCa |
| Mobile | BLE, NFC, Face Template on Mobile |
| Network | 10/100 Ethernet, Wi-Fi 2.4/5GHz |
| PoE | IEEE 802.3at (PoE+) |
| RS-485 | 4-ch (Host or Slave) |
| Wiegand | 2-ch In + 2-ch Out |
| TTL Input | 4 channels |
| Relay | 1 relay |
| Operating Temp | -20°C to +60°C |
| IP Rating | IP65 |
| IK Rating | IK06 |
| Dimensions | 82 × 168 × 28mm |
| Weight | 480g |

**Connection example:**
```javascript
await gsdk.connectDevice("MAIN-ENTRANCE", "192.168.10.101", 51211, true);
```

**Default network settings:**
- IP: 192.168.1.110
- Port: 51211 (clear) / 51212 (SSL)
- Username: admin
- Password: (printed on label)

**How to find IP on device:**
Menu → System Info → Network Info

---

## 2. BioStation A2 Plus (BSA2)

### Face + Fingerprint terminal

**Key capabilities:**
- Dual sensor: face recognition + fingerprint
- Outdoor rated IP65
- Supports up to 100,000 fingerprint templates
- RFID card reading (all major protocols)
- Anti-passback support

**Specifications:**
| Item | Value |
|------|-------|
| Face Users | 3,000 |
| Fingerprint Users | 100,000 |
| Max Users | 200,000 |
| Face Recognition | < 1.0 second |
| Fingerprint Matching | < 1.0 second |
| Network | 10/100 Ethernet |
| PoE | IEEE 802.3at |
| IP Rating | IP65 |
| Operating Temp | -20°C to +50°C |

---

## 3. FaceStation F2 (FSF2)

### High-performance face terminal — large installations

**Key capabilities:**
- NPU-optimized AI face recognition
- Up to 30,000 face users
- Face Template on Mobile credential
- VoIP intercom built-in
- Wide-angle camera for standing/seated access

**Specifications:**
| Item | Value |
|------|-------|
| CPU | 1.4GHz Quad-Core + NPU |
| Display | 5" IPS Touch |
| Face Users | 30,000 |
| Max Users | 500,000 |
| Recognition Speed | < 0.2 seconds |
| Network | Gigabit Ethernet + Wi-Fi |
| IP Rating | IP65 |
| Operating Temp | -20°C to +60°C |

---

## 4. BioEntry W3 (BEW3)

### Slim outdoor card + face reader

**Key capabilities:**
- Ultra-slim wall-mount design
- IP65 outdoor rated
- Face recognition + RFID card
- PoE+ powered — single cable installation
- Wiegand output for legacy panel integration

**Specifications:**
| Item | Value |
|------|-------|
| Form Factor | Slim (19mm depth) |
| Face Users | 3,000 |
| Card Types | MIFARE, DESFire, HID, EM4100 |
| Network | 10/100 Ethernet |
| PoE | IEEE 802.3af/at |
| IP Rating | IP65 |
| Wiegand | 1-ch Output |
| Operating Temp | -20°C to +50°C |
| Dimensions | 50 × 161 × 19mm |

---

## 5. BioLite N2 (BLN2)

### Compact card + PIN reader

**Key capabilities:**
- Card and PIN only — no face recognition
- Compact design for tight spaces
- Wiegand output — drop-in replacement for legacy readers
- RS-485 supported

**Specifications:**
| Item | Value |
|------|-------|
| Credentials | MIFARE, DESFire, HID, PIN |
| Wiegand | Input + Output |
| RS-485 | Supported |
| Network | Not standalone (connects via CoreStation or Wiegand) |
| IP Rating | IP52 (indoor) |
| Operating Temp | -10°C to +50°C |

---

## 6. CoreStation (CS)

### Centralized access control panel — up to 32 doors

**Key capabilities:**
- Central controller — connects up to 32 doors
- Connects BioLite N2, XPass 2, and Wiegand readers
- 32-channel relay output
- Anti-passback zones across all connected readers
- Offline operation with local database

**Specifications:**
| Item | Value |
|------|-------|
| Door Capacity | Up to 32 doors |
| Max Users | 500,000 |
| Log Capacity | 10,000,000 |
| Reader Interface | RS-485, Wiegand 26/34 |
| Relay Output | 32 channels |
| Network | Gigabit Ethernet |
| Power | 12V DC |
| IP Rating | Indoor, IP20 |

**Note:** CoreStation requires additional Suprema reader panels. It does not have its own biometric sensor.

---

## 7. XPass 2 (XP2)

### Outdoor RFID card reader

**Key capabilities:**
- IP65 outdoor rated
- RFID card only — no face or fingerprint
- PoE+ powered
- Compact vandal-proof design
- Wiegand output for panel integration

**Specifications:**
| Item | Value |
|------|-------|
| Credentials | MIFARE, DESFire, HID Prox, EM4100 |
| RF Range | Up to 120mm |
| Network | 10/100 Ethernet |
| PoE | IEEE 802.3af |
| IP Rating | IP65 |
| IK Rating | IK08 |
| Operating Temp | -30°C to +70°C |
| Dimensions | 72 × 127 × 18mm |

---

## 8. BioStation L2 (BSL2)

### Fingerprint + card terminal

**Key capabilities:**
- Optical fingerprint sensor — fast and accurate
- RFID card reading
- Compact indoor design
- USB host port for external storage

**Specifications:**
| Item | Value |
|------|-------|
| Fingerprint Users | 100,000 |
| Max Users | 500,000 |
| Fingerprint Speed | < 1.0 second |
| Card Types | MIFARE, DESFire, HID |
| Network | 10/100 Ethernet |
| IP Rating | IP52 (indoor) |
| Operating Temp | -10°C to +50°C |

---

## Network Setup for Any Device

### Step 1 — Physical connection
1. Connect PoE+ cable (for PoE-compatible devices) **or** 12V DC adapter
2. Connect Ethernet cable from device to your network switch
3. Wait for device to boot (LED turns green, about 30 seconds)

### Step 2 — Find/set IP address
**On the device screen:**
- Menu → System Info → Network → Current IP address is displayed

**Change the IP (on device screen):**
- Menu → Settings → Network → IP Address → Enter your static IP

**Recommended static IP range:**
```
Device 1:  192.168.10.101
Device 2:  192.168.10.102
...
Device 24: 192.168.10.124
```

### Step 3 — Firewall rules required
```
# Open on your server firewall
# For each device IP on your network:
ufw allow from 192.168.10.0/24 to any port 51211 proto tcp   # G-SDK clear
ufw allow from 192.168.10.0/24 to any port 51212 proto tcp   # G-SDK SSL

# Or on your network firewall/router:
# Allow TCP 51211 and 51212 from server IP to device IP range
```

### Step 4 — Test connectivity from server
```bash
# Ping the device
ping 192.168.10.101

# Test port is open
nc -zv 192.168.10.101 51211

# Or using nmap
nmap -p 51211 192.168.10.101
```

---

## Credential Compatibility Matrix

| Credential Type       | BS3 | BSA2 | FSF2 | BEW3 | BLN2 | CS | XP2 | BSL2 |
|----------------------|-----|------|------|------|------|----|-----|------|
| Face Recognition     | ✓   | ✓    | ✓    | ✓    | —    | —  | —   | —    |
| Fingerprint          | —   | ✓    | —    | —    | —    | —  | —   | ✓    |
| MIFARE Classic       | ✓   | ✓    | ✓    | ✓    | ✓    | ✓  | ✓   | ✓    |
| MIFARE Plus          | ✓   | ✓    | ✓    | ✓    | ✓    | ✓  | ✓   | ✓    |
| DESFire EV1/EV2/EV3  | ✓   | ✓    | ✓    | ✓    | ✓    | ✓  | ✓   | ✓    |
| iCLASS               | ✓   | ✓    | ✓    | ✓    | ✓    | ✓  | —   | ✓    |
| HID SEOS             | ✓   | —    | ✓    | —    | —    | —  | —   | —    |
| HID Prox             | ✓   | ✓    | ✓    | ✓    | ✓    | ✓  | ✓   | ✓    |
| EM4100               | ✓   | ✓    | ✓    | ✓    | ✓    | ✓  | ✓   | ✓    |
| FeliCa               | ✓   | —    | ✓    | —    | —    | —  | —   | —    |
| PIN                  | ✓   | ✓    | ✓    | ✓    | ✓    | ✓  | —   | ✓    |
| Mobile BLE/NFC       | ✓   | —    | ✓    | —    | —    | —  | —   | —    |
| QR Code              | ✓   | —    | ✓    | —    | —    | —  | —   | —    |

---

## Default Network Settings (Factory Reset)

| Device | Default IP | Port | Admin User | Notes |
|--------|-----------|------|------------|-------|
| BioStation 3 | 192.168.1.110 | 51211 | admin | Password on device label |
| BioStation A2 Plus | 192.168.1.110 | 51211 | admin | Password on device label |
| FaceStation F2 | 192.168.1.110 | 51211 | admin | Password on device label |
| BioEntry W3 | 192.168.1.110 | 51211 | admin | Password on device label |
| BioLite N2 | — | 51211 | — | Connects via RS-485 |
| CoreStation | 192.168.1.110 | 51211 | admin | Password on device label |
| XPass 2 | 192.168.1.110 | 51211 | admin | Password on device label |
| BioStation L2 | 192.168.1.110 | 51211 | admin | Password on device label |

---

## Where to Buy / Support

- **Suprema website:** https://www.supremainc.com
- **G-SDK documentation:** https://kb.supremainc.com/b_sdk/
- **Technical support:** +82 31 783 4502
- **Regional distributors:** https://www.supremainc.com/en/about/contact-us.asp

**Supported firmware versions (G-SDK 1.7.2):**
- BioStation 3: v3.3.0 or higher (v3.5.x recommended)
- FaceStation F2: v2.2.0 or higher
- All others: v2.0.0 or higher
