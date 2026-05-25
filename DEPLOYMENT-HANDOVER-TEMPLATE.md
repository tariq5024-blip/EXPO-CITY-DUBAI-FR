# Expo-FR Deployment Handover (Single Master Document)

Use this as the single source of truth before and after deployment.

---

## 1) Project + Environment Summary

- Project: `Expo-FR` (Expo City Dubai FR/ACS)
- Frontend URL (current): `http://localhost:5173`
- Backend URL (current): `http://localhost:4000`
- Mongo DB (current): `mongodb://localhost:27017/expo-fr`
- Sidecar (current): `http://localhost:4500`
- Gateway RPC target (current observed): `172.20.0.1:4100`
- Log retention policy: `100 days` rolling (TTL)

---

## 2) Central API Integration (Hybrid Strategy)

### 2.1 Required from central API team

- Base URL (dev/stage/prod): `____________________`
- Auth method: `Bearer token` / `X-API-KEY` / `OAuth` / other: `____________________`
- Users endpoint path: `____________________` (default app value: `/users`)
- Devices endpoint path: `____________________` (default app value: `/devices`)
- Poll interval target: `____________________` ms (default app value: `60000`)
- Timeout target: `____________________` ms (default app value: `15000`)

### 2.2 Sample payloads to provide (mandatory)

- Users API sample request/response JSON (real contract)
- Devices API sample request/response JSON (real contract)
- Pagination/update filter rule:
  - page/cursor param names
  - updated-since param
  - sort order guarantees

---

## 3) Data Mapping Contract (Central API -> Expo-FR)

Fill and validate these fields:

- `employeeId` <- `____________________`
- `supremaUserId` <- `____________________`
- `name` <- `____________________`
- `cardId/cardNo` <- `____________________`
- `designation` <- `____________________`
- `department` <- `____________________`
- `division` <- `____________________`
- `status` <- `____________________` (`active/inactive/suspended`)
- `photo/facePhoto` <- `____________________` (base64/data-url/public URL)
- `companyId/companyCode/companyName` <- `____________________`

Conflict rule:

- Central is source of truth? `Yes / No`
- Local manual edits allowed? `Yes / No`
- Delete behavior: `Hard delete / Mark inactive / Ignore`

---

## 4) Reader + Gateway Connectivity

### 4.1 Must provide

- Device inventory table:
  - Reader name
  - Reader IP
  - Suprema numeric device ID
  - Zone/building
  - SSL mode
- Gateway host IP/FQDN: `____________________`
- Gateway RPC port: `4100` (or custom: `________`)
- Device TCP port: `51211` (or custom: `________`)

### 4.2 Current known values (from this setup)

- Device TCP expected: `51211`
- Gateway RPC expected: `4100`
- Sidecar health endpoint: `http://localhost:4500/health`

---

## 5) Security + Secrets Checklist

Provide/confirm:

- `JWT_SECRET`: `____________________`
- Central API token/key: `____________________`
- SMTP host/user/pass/from: `____________________`
- Allowed frontend origins (CORS): `____________________`
- TLS cert strategy:
  - Domain cert(s)
  - Gateway CA/cert paths
  - Renewal process owner

Never commit secrets to git. Use environment variables or secret manager.

---

## 6) Performance + Scale Targets

Target profile:

- Companies: `100`
- Employees: `6000`
- Retention: `100 days`
- Expected access events/day: `____________________`
- Peak events/minute: `____________________`

Already implemented in app:

- Mongo indexes for employees/logs/devices
- 100-day TTL on logs
- Request timeout guard
- API rate limits
- Healthchecks + readiness

---

## 7) Backup / Restore Policy (Production)

### 7.1 Commands

- Backup: `npm run backup --workspace backend`
- Restore: `npm run restore --workspace backend -- /path/to/backup.json.gz`
- Load test seed: `npm run loadtest --workspace backend`

### 7.2 Policy to fill

- Backup frequency: `____________________` (recommended: every 6h + daily off-host)
- Retention of backups: `____________________` (e.g., 30 daily + 12 monthly)
- Restore drill frequency: `____________________` (recommended: monthly)
- Backup storage location: `____________________` (NAS/S3/etc)

---

## 8) Monitoring + Alerts

Configured endpoints:

- Health: `GET /api/health`
- Ready: `GET /api/ready`
- Metrics (JWT): `GET /api/metrics`

Fill alert routing:

- Email/Slack/Teams webhook: `____________________`
- On-call owner: `____________________`
- Escalation path: `____________________`

Threshold suggestions:

- Backend unhealthy > 2 checks
- Mongo disconnected
- Central API sync failures > 3 consecutive polls
- Deny-rate spike above baseline

---

## 9) Deployment Plan (Pre-Go-Live)

- Infra provisioned (CPU/RAM/Disk): `____________________`
- Domain + TLS active: `____________________`
- Reverse proxy configured: `Nginx / Traefik / other`
- Compose file used: `docker-compose.prod.yml`
- Go-live date/time: `____________________`
- Rollback window: `____________________`

Recommended rollout:

1. Backup DB
2. Deploy to staging
3. UAT sign-off
4. Production deploy
5. Monitor 30-60 min
6. Keep rollback image tag ready

---

## 10) Post-Deployment: What May Change

These values commonly change after deployment and must be updated in this document:

- Central API base URL/token
- Gateway host IP / DNS
- Reader inventory (new devices, changed IPs)
- SMTP credentials / sender domain
- Public frontend/backend URLs
- CORS allowlist
- Poll interval and timeout tuning
- Rate-limit thresholds
- Backup destination and retention window
- Alert endpoints and on-call owners

These are usually stable and should not change often:

- Log retention policy (`100 days`) unless compliance changes
- Core ports (`4000`, `4500`, `4100`, `51211`) unless network architecture changes
- Primary entity mapping (`employeeId`, `supremaUserId`) once finalized

---

## 11) UAT Sign-off Table

| Test Case | Owner | Result | Notes |
|---|---|---|---|
| Login + RBAC pages |  |  |  |
| Central API pull users |  |  |  |
| Central API pull devices |  |  |  |
| Push users/photos to readers |  |  |  |
| Reader event appears in Live Monitor |  |  |  |
| Access log shows scan time + scan photo + enrollment photo |  |  |  |
| Backup command works |  |  |  |
| Restore drill works |  |  |  |
| Alerts trigger correctly |  |  |  |

---

## 12) Final Production .env Checklist (Fill Before Go-Live)

- `PORT=4000`
- `MONGODB_URI=____________________`
- `JWT_SECRET=____________________`
- `GSDK_GATEWAY=____________________`
- `GSDK_USE_SSL=true/false`
- `GSDK_DEVICE_PORT=51211`
- `GSDK_SIDECAR_URL=____________________`
- `LOG_RETENTION_DAYS=100`
- `REQUEST_TIMEOUT_MS=____________________`
- `RATE_LIMIT_WINDOW_MS=____________________`
- `RATE_LIMIT_MAX=____________________`
- `RATE_LIMIT_AUTH_MAX=____________________`
- `CENTRAL_API_ENABLED=true/false`
- `CENTRAL_API_BASE_URL=____________________`
- `CENTRAL_API_API_KEY=____________________`
- `CENTRAL_API_USERS_PATH=____________________`
- `CENTRAL_API_DEVICES_PATH=____________________`
- `CENTRAL_API_POLL_MS=____________________`
- `CENTRAL_API_TIMEOUT_MS=____________________`
- `CENTRAL_API_AUTO_PUSH_TO_READERS=true/false`
- `SMTP_HOST=____________________`
- `SMTP_PORT=____________________`
- `SMTP_USER=____________________`
- `SMTP_PASS=____________________`
- `SMTP_FROM=____________________`

---

### Owner Sign-off

- Technical owner: `____________________`
- Operations owner: `____________________`
- Security owner: `____________________`
- Approved for production on: `____________________`

