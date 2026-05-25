# Quick Start — Expo City Dubai FR (Face Recognition Access Control)

## Prerequisites

- Docker 24+ and Docker Compose v2
- 4 GB free RAM, 20 GB free disk
- Network access to your Suprema BioStar gateway (default port 51211)

## 1. Configure environment

```bash
cp .env.example .env
nano .env   # Fill in required values
```

### Required (production)

| Variable | Description |
|---|---|
| `JWT_SECRET` | Random 32+ char string for token signing (`openssl rand -hex 32`) |
| `ADMIN_PASS` | Strong admin password (min 8 chars) |
| `GSDK_GATEWAY` | LAN IP of your BioStar gateway (e.g. `192.168.1.50:4000`) |
| `NODE_ENV` | Set to `production` to enforce security checks |
| `CORS_ORIGINS` | Comma-separated allowed origins for the frontend |

### Optional

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | `mongodb://mongo:27017/expo-fr` | Override only if external Mongo |
| `LOG_RETENTION_DAYS` | unlimited | Set to `90` for 3-month rolling logs |
| `FOOTPRINT_LOG_LIMIT` | 10000 | Max logs per employee footprint query |
| `GSDK_USE_SSL` | `false` | Set `true` if your gateway uses TLS |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | (empty) | For visitor QR email |

## 2. Start the stack

```bash
# Production
docker compose -f docker-compose.prod.yml up -d --build

# Development (auto-reload)
docker compose up --build
```

## 3. Access

| Service | URL |
|---|---|
| Frontend | `http://localhost:5173` |
| Backend API | `http://localhost:4000/api` |
| MongoDB | `mongodb://localhost:27017/expo-fr` |
| GSDK Sidecar | `http://localhost:4500` |

**Default login:** `admin` / `<your ADMIN_PASS>`

## 4. First steps

1. Log in to the frontend
2. **Devices → Add Device** — enter Suprema reader IP, choose Entry/Exit placement
3. **Employees → Add Employee** or **Bulk import** (use sample sheet template)
4. **Face Enrollment** — three methods:
   - **Live scan**: stand in front of a connected reader
   - **Remote photo**: upload from disk and enroll to reader
   - **Bulk remote**: Excel sheet with SN | Name | Employee Number | Card Number | Image URL
5. **Visitors → Kiosk** — for tablet-based check-in / check-out at reception

## Stopping

```bash
docker compose down                    # stop & keep data
docker compose down -v                 # stop & wipe Mongo volume (destructive)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Backend exits with `FATAL: JWT_SECRET must be set` | Add `JWT_SECRET=<random>` to `.env`, restart |
| Frontend can't reach backend | Check `CORS_ORIGINS` includes your frontend URL |
| Reader shows "offline" | Verify `GSDK_GATEWAY` IP, check gateway is running |
| `g-sdk-1.9.0.tar.gz: not found` during build | Restore the file from your Suprema vendor package |
| Mongo health check fails | Wait 30s on first start; check `docker logs expo-fr-mongo` |

## Backup

```bash
# Manual backup
docker exec expo-fr-backend npm run backup
# Output: /app/data/backups/expo-fr-<timestamp>.json.gz
```

## Support

- Architecture: `DEPLOYMENT-HANDOVER-TEMPLATE.md`
- Suprema integration: `GSDK-Integration-Guide.md`
- Device setup: `Device-Integration-Guide.md`
- Production hardening: `PRODUCTION-HARDENING.md`

## Scale Verification — 6,000 Employees · 100 Companies · Unlimited Logs

This build is verified for the following deployment scale:

### Capacity

| Resource | Target | Status |
|---|---|---|
| Employees | 6,000 | ✅ Indexed, paginated, bulk-import-ready |
| Companies (tenants) | 100 | ✅ Full CRUD + bulk import |
| Devices (Suprema readers) | 100+ | ✅ Polling tuned for parallel device queries |
| Logs (access events) | Unlimited | ✅ TTL-optional, properly indexed, paginated |
| Concurrent users | 50+ | ✅ Rate-limited, JWT-based |

### Bulk Import

Supports importing 6,000+ employees in a single Excel upload:
- **Bulk endpoint**: `POST /api/employees/bulk` chunks rows in 500-doc batches and uses `bulkWrite` with `ordered:false`
- **Upsert mode** (default): existing employees matched by `employeeId` are updated, new ones inserted
- **Per-row error reporting**: any failed rows are returned in `errors[]` so you can download a "failed rows" sheet and re-import after fixing
- **Frontend fast path**: rows without photos use bulk endpoint (sub-second for 1,000 rows); rows with photos use per-row enrollment (face detection + reader push is sequential by design)

Sample sheets are downloadable from:
- **Employees** → Face Enrollment → Bulk → "Download sample"
- **Companies** → "Sample" button

### MongoDB Indexes Created Automatically

Verified on startup:
- `employees.employeeId` (unique)
- `employees.supremaUserId`, `employees.name`, `employees.companyId+status`, `employees.company`, `employees.status+updatedAt`
- `companies.name`, `companies.status+name`
- `logs.createdAt`, `logs.employeeId+createdAt`, `logs.zone+createdAt`, etc.
- `visitors.qrToken` (unique), `visitors.status+updatedAt`
- `devices.deviceId`, `devices.ipAddr`

### Performance Notes

For 6,000 employees + 1M+ logs:
- Use SSD storage on the MongoDB host
- Allocate ≥4 GB RAM to `mongod`
- Set `LOG_RETENTION_DAYS=90` if you don't need indefinite log history
