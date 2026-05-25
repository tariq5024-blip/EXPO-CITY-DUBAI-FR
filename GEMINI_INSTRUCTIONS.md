# Gemini Instructions - Expo-FR Deployment Runbook

Use this file as the single deployment instruction source for Gemini (or any AI/operator) when setting up, running, validating, and troubleshooting this project.

---

## 1) Project Overview

This repository contains:

- `frontend` - React + Vite app (main file: `frontend/src/App.jsx`)
- `backend` - Node.js + Express API (`backend/src/server.js`)
- `mongo` - MongoDB database
- `ollama` - optional local LLM runtime for AI features
- `gsdk-sidecar` - Node 14 sidecar for Suprema G-SDK compatibility

Main runtime ports:

- Frontend: `5173`
- Backend: `4000`
- MongoDB: `27017`
- Ollama: `11434` (optional / profile-based in Docker)
- GSDK sidecar: `4500`

---

## 2) Required Files Before Deployment

Verify these files exist in repo root:

- `.env` (copy from `.env.example` if missing)
- `g-sdk-1.9.0.tar.gz` (required by backend and gsdk-sidecar Docker builds)
- `docker-compose.yml`

Brand assets expected inside repository:

- `frontend/public/company-logo.png`
- `frontend/public/sidebar-logo.png`
- `frontend/public/tab-logo.png` (favicon)

---

## 3) Environment Variables

### 3.1 Local Host Run (`npm run dev:*`)

Use host addresses in `.env`:

- `MONGODB_URI=mongodb://localhost:27017/expo-fr`
- `OLLAMA_HOST=http://localhost:11434`
- `GSDK_SIDECAR_URL=http://localhost:4500`
- `PORT=4000`

### 3.2 Docker Compose Run

In Docker Compose, service-to-service network hostnames are used:

- backend -> mongo via `mongodb://mongo:27017/expo-fr`
- backend -> ollama via `http://ollama:11434`
- backend -> sidecar via `http://gsdk-sidecar:4500`

Do not hardcode host absolute file paths in compose for deployment portability.

---

## 4) Deployment Modes

## A) Docker Deployment (Recommended)

### A1. Build and start core stack (without AI model container profile)

```bash
cd /path/to/Expo-FR
docker compose up --build -d
```

### A2. Build and start with Ollama profile enabled

```bash
cd /path/to/Expo-FR
docker compose --profile ai up --build -d
```

### A3. Pull model into Ollama (required for AI chat features)

```bash
docker exec -it expo-fr-ollama ollama pull llama3.2
```

### A4. Validate services

```bash
docker compose ps
docker compose logs --tail=100 backend
docker compose logs --tail=100 frontend
docker compose logs --tail=100 gsdk-sidecar
```

Backend health check:

```bash
curl http://localhost:4000/api/health
```

Frontend URL:

- `http://localhost:5173`

---

## B) Local Dev Run (without Docker)

Open two terminals:

Terminal 1:

```bash
cd /path/to/Expo-FR
npm run dev:backend
```

Terminal 2:

```bash
cd /path/to/Expo-FR
npm run dev:frontend
```

Optional seed:

```bash
cd /path/to/Expo-FR
npm run seed
```

---

## 5) Port Conflict Recovery

If app URLs do not open or backend fails with `EADDRINUSE`:

```bash
sudo fuser -k 4000/tcp 5173/tcp 5174/tcp 5175/tcp
```

Then restart backend/frontend.

---

## 6) G-SDK Requirements and Behavior

This project expects legacy Suprema assets and compatibility handling:

- backend image installs `g-sdk-1.9.0.tar.gz`
- `gsdk-sidecar` runs Node 14 and installs SDK from same archive
- backend uses `GSDK_SIDECAR_URL` for status and device test routes

If G-SDK features fail:

1. Confirm `g-sdk-1.9.0.tar.gz` exists in project root
2. Rebuild backend + sidecar images
3. Check sidecar logs:

```bash
docker compose logs --tail=200 gsdk-sidecar
```

4. Verify sidecar health endpoint (from host):

```bash
curl http://localhost:4500/health
```

---

## 7) Reports, Attendance Export, and Email

Attendance features added in Reports tab include:

- person-level attendance table
- person selection
- Excel/CSV export for selected/all
- email attendance CSV attachment via SMTP

SMTP configuration must be set in app settings or `.env`:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

If email sending fails, verify SMTP endpoint config and backend logs:

```bash
docker compose logs --tail=200 backend
```

or for local run, check backend terminal output.

---

## 8) Known Operational Notes

- Native browser `type="date"` can show locale format; app uses explicit `dd/mm/yyyy` format in attendance filters.
- App-wide display date format is set to `dd/mm/yy`.
- Live monitor photos show:
  - live scan photo (if provided by event)
  - enrolled photo (if found in employee/visitor record)
  - fallback generated image when none available
- Access Logs and FR Monitor support date range filters plus AI insight actions.
- Device placement (`entry`/`exit`) is part of setup/edit and drives on-premise logic.

---

## 9) Post-Deployment Smoke Test Checklist

After each deployment, verify:

1. Login page loads and branding assets render.
2. Dashboard loads without top-card regressions.
3. FR Live Monitor receives events and card click opens large two-photo modal.
4. Employees page shows Presence + In/Out + Duration.
5. Visitors page shows Check-in/Check-out/Duration.
6. Access Logs detail modal shows Live Scan + Enrollment photo.
7. Footprints views show photo thumbnails where available.
8. Reports -> Attendance table loads rows.
9. Attendance export (Excel/CSV) downloads.
10. Attendance email sends successfully (if SMTP configured).

---

## 10) Standard Restart / Recovery Commands

Docker:

```bash
docker compose down
docker compose up --build -d
```

Local:

```bash
sudo fuser -k 4000/tcp 5173/tcp
cd /path/to/Expo-FR
npm run dev:backend
npm run dev:frontend
```

---

## 11) Instructions for Gemini Agent

When Gemini is asked to deploy or troubleshoot this repo, it should:

1. Read this file first.
2. Validate required files listed in section 2.
3. Choose deployment mode (Docker vs local) based on user request.
4. Ensure no machine-specific absolute bind mounts are introduced.
5. Confirm runtime health endpoints and UI availability.
6. Run smoke tests from section 9.
7. Provide exact remediation commands for any failed check.

Do not skip G-SDK archive validation, SMTP validation (if email is requested), or model availability checks for Ollama-enabled flows.

---

## 12) Zero-Trouble Quick Start (Recommended)

Use this exact sequence on a new machine:

1. Install prerequisites:
   - Docker + Docker Compose plugin
   - Git
   - (Optional local mode) Node 18+ and npm
2. Clone repo and enter directory:

```bash
git clone <your-repo-url> Expo-FR
cd Expo-FR
```

3. Prepare environment:

```bash
cp .env.example .env
```

4. Verify required binary/archive assets:
   - `g-sdk-1.9.0.tar.gz` exists in repo root
   - logos exist in `frontend/public/`
5. Run one-command production deploy:

```bash
./deploy.sh --down-first
```

6. If AI features are needed:

```bash
./deploy.sh --ai --pull-model llama3.2 --down-first
```

7. Validate:
   - Frontend: `http://localhost:5173`
   - Backend health: `http://localhost:4000/api/health`

---

## 13) Production Files and Commands

This repo includes:

- `docker-compose.prod.yml` - production-focused compose stack
- `deploy.sh` - deployment helper with validation + health checks

Manual production equivalent:

```bash
docker compose -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.prod.yml ps
```

With AI profile:

```bash
docker compose -f docker-compose.prod.yml --profile ai up --build -d
docker exec -it expo-fr-ollama ollama pull llama3.2
```

---

## 14) Troubleshooting Matrix

### A) `http://localhost:5173` not opening

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=200 frontend
sudo fuser -k 5173/tcp
docker compose -f docker-compose.prod.yml restart frontend
```

### B) Backend starts but Mongo errors (`ENOTFOUND mongo`, `EAI_AGAIN`, etc.)

- In Docker mode: backend must use `mongodb://mongo:27017/expo-fr`
- In local mode: backend must use `mongodb://localhost:27017/expo-fr`
- Confirm Mongo is running and reachable on `27017`

### C) G-SDK unavailable

```bash
ls -la g-sdk-1.9.0.tar.gz
docker compose -f docker-compose.prod.yml build backend gsdk-sidecar --no-cache
docker compose -f docker-compose.prod.yml logs --tail=300 gsdk-sidecar
```

### D) Attendance email not sending

1. Confirm SMTP configured in app settings or `.env`
2. Verify backend logs:

```bash
docker compose -f docker-compose.prod.yml logs --tail=300 backend
```

3. Verify outbound SMTP access/firewall on host

### E) Port already in use

```bash
sudo fuser -k 4000/tcp 5173/tcp 4500/tcp 11434/tcp 27017/tcp
docker compose -f docker-compose.prod.yml up --build -d
```

---

## 15) What Gemini Must Ask User Before Production Deploy

Gemini must confirm these before final deployment:

1. Is this server allowed to run Docker containers?
2. Is `g-sdk-1.9.0.tar.gz` present in repo root?
3. Should Ollama AI be enabled now (`--ai`)?
4. Which Ollama model should be pulled (`llama3.2` default)?
5. Is SMTP required immediately for attendance emailing?

If any answer is unknown, Gemini should proceed with base stack and clearly print what remains pending.

---

## 16) Finalized Features (Production Baseline)

The following features are now part of the production baseline and must be preserved:

1. **Bulk face enrollment (remote) with Excel support**
   - Supports employee data rows and image-based enrollment workflow.
   - Accepts row photos via:
     - embedded Excel row images, or
     - `photoBase64` / image data URL column, or
     - separate uploaded files mapped by pass/name.
   - Provides:
     - sample template download,
     - failed rows export,
     - requeue failed only,
     - one-click retry for failed rows,
     - retry counters (`Failed`, `Ready to retry`).

2. **Full backup/restore in Settings**
   - Backup download exports all non-system Mongo collections.
   - Restore upload supports complete replacement restore for included collections.
   - Restore preview modal shows:
     - collection names,
     - per-collection row counts,
     - impact indicators (small/large/very large via green/amber/red).

3. **Dashboard and access behavior**
   - `Granted Today` card split into unique employees + total grants.
   - `On Premises` reflects employees currently inside based on latest granted direction.
   - Device warning/offline behavior aligns with health + issue state.

4. **Date handling baseline**
   - App standard date display: `dd/mm/yy`.
   - Input parsing supports `dd/mm/yy` and `dd/mm/yyyy` safely.

---

## 17) Production Deployment Command (Canonical)

Use this exact command sequence for final production rollouts:

```bash
cd /path/to/Expo-FR
./deploy.sh --down-first
docker compose -f docker-compose.prod.yml ps
curl -fsS http://localhost:4000/api/health
curl -fsS http://localhost:4000/api/ready
curl -fsS http://localhost:5173 >/dev/null
```

If AI is required:

```bash
cd /path/to/Expo-FR
./deploy.sh --ai --pull-model llama3.2 --down-first
```

---

## 18) Final Smoke Tests (Must Pass)

After production deploy:

1. Login works and dashboard loads.
2. Settings -> Backup Data downloads JSON.
3. Settings -> Upload Restore Backup shows preview modal with collection counts and colors.
4. Face Enrollment -> Bulk / remote:
   - sample template downloads,
   - sheet upload parses rows,
   - failed rows export works,
   - retry/requeue actions work.
5. Access Logs and FR Monitor filters function with `dd/mm/yy`.
6. `docker compose -f docker-compose.prod.yml ps` shows healthy services.

