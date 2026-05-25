# Production Hardening Guide

This project is prepared for higher scale with:
- Mongo indexes for faster reads/writes at `100 companies / 6000 employees`
- Rolling log retention (`LOG_RETENTION_DAYS`, default `100`)
- API guardrails (request timeout + rate limits)
- Service healthchecks + restart behavior in compose

## 1) Backup / Restore Policy

### Daily backup
- Command: `npm run backup --workspace backend`
- Output: `backups/expo-fr-backup-<timestamp>.json.gz`
- Recommended policy:
  - Every 6 hours local backup
  - Daily off-host copy (NAS/S3)
  - Keep at least 30 daily + 12 monthly snapshots

### Restore
- Command: `npm run restore --workspace backend -- /absolute/path/to/backup.json.gz`
- Optional: preserve accounts
  - `RESTORE_PRESERVE_ACCOUNTS=true npm run restore --workspace backend -- /path/file.json.gz`

## 2) Healthchecks + Restart

Compose now includes healthchecks for:
- `mongo` (`ping`)
- `backend` (`/api/ready`)
- `frontend` (`/`)
- `gsdk-sidecar` (`/health`)

Recommended run mode:
- `docker compose up -d --build`
- verify: `docker compose ps`

## 3) Rate Limits + Timeout Budget

Configured in backend:
- `REQUEST_TIMEOUT_MS` default `30000`
- `RATE_LIMIT_WINDOW_MS` default `60000`
- `RATE_LIMIT_MAX` default `1200`
- `RATE_LIMIT_AUTH_MAX` default `60`

Tune for your traffic profile (reverse proxy + CDN + WAF recommended in production).

## 4) Load Testing (6000 employees)

Seed high-volume test data:
- `npm run loadtest --workspace backend`

Environment knobs:
- `LOADTEST_COMPANIES` (default `100`)
- `LOADTEST_EMPLOYEES` (default `6000`)
- `LOADTEST_LOGS_PER_EMPLOYEE` (default `4`)

## 5) Observability + Alerting

Use:
- `GET /api/health` (public status)
- `GET /api/ready` (readiness gate)
- `GET /api/metrics` (JWT required)

Recommended alerts:
- backend healthcheck failing > 2 consecutive checks
- `denyRatePct` spike above baseline
- no device pulls for > 2 intervals (`lastDeviceEventPullStats`)
- Mongo down / reconnect loops

## 6) Safe Deployment Checklist

1. Run backup before release.
2. Deploy to staging first (`docker-compose.prod.yml`).
3. Smoke test:
   - login
   - device connect
   - live event appears in monitor + logs
   - enrollment + live scan photos visible
4. Monitor health/metrics for 15-30 minutes.
5. Promote to production.
6. Keep previous image tags for fast rollback.

## 7) Blue/Green (Simple)

- Keep two stacks (`expo-fr-blue`, `expo-fr-green`) on different ports.
- Run health checks on new stack.
- Switch reverse proxy traffic when healthy.
- Keep old stack warm for quick rollback window.
