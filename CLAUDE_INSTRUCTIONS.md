# Claude Instructions — Expo-FR deployment (USB / second laptop)

Use this file as the **primary instruction source** for Claude when the project is **copied to another machine via USB** (or any offline transfer) and must be brought up on a fresh **Ubuntu** laptop with Docker.

For deeper troubleshooting, SMTP, G-SDK, and feature smoke tests, also read `GEMINI_INSTRUCTIONS.md`.

---

## 1) What this project is

- **Frontend:** React + Vite (`frontend/`, entry `frontend/src/App.jsx`)
- **Backend:** Node.js + Express (`backend/src/server.js`)
- **Database:** MongoDB (Docker service `mongo`)
- **Optional:** Ollama (`ai` profile), G-SDK sidecar for Suprema devices

**Ports (host):**

| Service    | Port  |
|-----------|-------|
| Frontend  | 5173  |
| Backend   | 4000  |
| MongoDB   | 27017 |
| G-SDK sidecar | 4500 |
| Ollama (optional) | 11434 |

---

## 2) USB transfer — what to copy

**Copy the entire project folder** (e.g. `Expo-FR/`) so these exist on the target laptop:

**Required for Docker builds**

- `docker-compose.yml` and/or `docker-compose.prod.yml`
- `backend/Dockerfile`, `frontend/Dockerfile`, `gsdk-sidecar/Dockerfile` (paths as in repo)
- **`g-sdk-1.9.0.tar.gz`** at the **repository root** (backend/sidecar images install from this)

**Required for configuration**

- `.env.example` (always present in repo)
- After copy: create **`.env`** on the target machine (see §4). Do **not** assume `.env` came from the USB unless you intentionally copied it; it may be gitignored.

**Optional / large**

- You may **omit** `node_modules/` and `frontend/dist/` on the USB to save space; reinstall/build on the target (see §5).
- Keeping `g-sdk-1.9.0/` source tree is optional if `g-sdk-1.9.0.tar.gz` is present.

**Verify after copy**

```bash
cd /path/to/Expo-FR
test -f g-sdk-1.9.0.tar.gz && echo "G-SDK archive OK" || echo "MISSING g-sdk-1.9.0.tar.gz"
test -f docker-compose.yml && echo "compose OK" || echo "MISSING docker-compose.yml"
```

---

## 3) Target laptop prerequisites (Ubuntu)

Install **Docker Engine** and **Docker Compose v2** (plugin). User must be in the `docker` group or use `sudo` for Docker commands.

```bash
docker --version
docker compose version
```

Optional for seeding from the host without entering a container:

- **Node.js 18+** and `npm` (for `npm install` at repo root and `npm run seed`)

---

## 4) Environment file (`.env`)

On the **new** machine:

```bash
cd /path/to/Expo-FR
cp .env.example .env
# Edit .env: set JWT_SECRET to a long random string for non-dev use.
```

**Important for Docker Compose:** `docker-compose.yml` loads `./.env`. The backend service overrides `MONGODB_URI` to `mongodb://mongo:27017/expo-fr` inside the stack — you normally **do not** need to change that for container-to-container networking.

**Login-related variables (must stay consistent with what the user types):**

- `ADMIN_USER` / `ADMIN_PASS` — bootstrap admin (defaults in `.env.example`: `admin` / `admin123`)
- `DEMO_PASSWORD` — password for **demo** users including **`superadmin`** (default **`password`** if unset)

If login fails after deploy, check these were not changed accidentally.

---

## 5) Dependencies (if not using Docker for dev)

If you run tools on the host (e.g. `npm run seed`):

```bash
cd /path/to/Expo-FR
npm install
```

Omit copying `node_modules/` from another OS/CPU; reinstall on the target.

---

## 6) Start the stack (recommended: Docker)

From the repo root:

**Development-style compose (foreground logs):**

```bash
docker compose up --build
```

**Detached:**

```bash
docker compose up --build -d
```

**Production-style file (uses `npm run preview` for frontend):**

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

Or use the helper script (expects `.env`, `g-sdk-1.9.0.tar.gz`, and logo files — see `deploy.sh`):

```bash
chmod +x deploy.sh
./deploy.sh
```

**Optional AI (Ollama):**

```bash
docker compose --profile ai up --build -d
```

Wait until `mongo` and `backend` are healthy enough; then seed (§7).

---

## 7) Seed MongoDB (required for full demo data + DB-backed superadmin)

After MongoDB is listening on **localhost:27017** (published by Compose), from the **host** at repo root:

```bash
cd /path/to/Expo-FR
npm install   # if not already done
npm run seed
```

This uses `MONGODB_URI` from `.env` (default `mongodb://localhost:27017/expo-fr` in `.env.example`), which matches the exposed Mongo port.

**Re-run seed** if the database volume was wiped (`docker compose down -v`).

---

## 8) Login credentials after deployment

Use **one** of these (depending on `.env` and whether seed ran):

| Method | Username | Password | Notes |
|--------|----------|----------|--------|
| Demo user | `superadmin` | `password` | Uses `DEMO_PASSWORD` (default `password`) |
| Seeded MongoDB account | `superadmin` | `password` | After `npm run seed` (account in DB with plaintext password) |
| Env bootstrap | `admin` | `admin123` | From default `.env.example` (`ADMIN_USER` / `ADMIN_PASS`) |

If `superadmin` / `password` fails:

1. Confirm `DEMO_PASSWORD` in `.env` (or leave unset for default `password`).
2. Confirm `npm run seed` completed successfully.
3. Open the app using the **same host** you use for API access (§9).

---

## 9) Access from the same machine vs another PC on the LAN

- **This laptop:** `http://localhost:5173` or `http://127.0.0.1:5173`
- **Another device on the network:** `http://<this-laptop-LAN-IP>:5173`

The frontend is configured so that when the hostname is **not** localhost, API calls go to **`http://<same-hostname>:4000/api`**, so the browser reaches the backend on port **4000**. Ensure the firewall allows **5173** and **4000** if you access from another machine.

**Reverse proxy / HTTPS:** If you terminate TLS on one hostname/port, set at **build time**:

`VITE_API_BASE_URL` — full origin of the API (no trailing slash), e.g. `https://acs.example.com`.

---

## 10) Quick validation

```bash
curl -fsS http://localhost:4000/api/health && echo " backend OK"
curl -fsSI http://localhost:5173 | head -n1
docker compose ps
```

---

## 11) Common failures after USB copy

| Symptom | What to check |
|--------|----------------|
| Build fails on G-SDK | `g-sdk-1.9.0.tar.gz` exists at repo root; rebuild images |
| Backend cannot connect to Mongo | Containers up; `docker compose logs mongo backend` |
| Login always fails | `.env` credentials; run `npm run seed`; open UI at `http://IP:5173` not wrong port; API on 4000 reachable |
| “Works on first laptop, not second” | Fresh Docker volume = empty DB → seed again; new `.env` → match passwords or reset |

---

## 12) Operator checklist (minimal)

1. Copy full project from USB; verify `g-sdk-1.9.0.tar.gz` and compose files.
2. Install Docker on Ubuntu target.
3. `cp .env.example .env` and set `JWT_SECRET` (and optional SMTP later).
4. `docker compose up --build -d`
5. `npm install && npm run seed` from repo root.
6. Open `http://localhost:5173` and log in with **`superadmin` / `password`** (unless `.env` overrides demo/env passwords).

---

*End of Claude USB deployment instructions.*
