# Expo-FR Setup

This project is now scaffolded with:

- React + Vite frontend (main app in `frontend/src/App.jsx`)
- Node.js backend API
- MongoDB integration
- Ollama integration
- Suprema G-SDK dependency installed in backend
- Docker Compose for full stack startup
- Local Suprema G-SDK archive support (`g-sdk-1.9.0.tar.gz`)

## Run locally (without Docker)

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Frontend: `http://localhost:5173`  
Backend health: `http://localhost:4000/api/health`

## Run with Docker

```bash
docker compose up --build
```

Services:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`
- MongoDB: `localhost:27017`
- Ollama: `localhost:11434`

### Faster start without Ollama (while AI image downloads)

```bash
docker compose up --build
```

`ollama` now runs behind the `ai` profile, so default startup skips it.

Start with AI service enabled:

```bash
docker compose --profile ai up --build
```

### G-SDK note

- The provided G-SDK Node client is installed in Docker during backend image build from `g-sdk-1.9.0.tar.gz`.
- If you run backend directly on host, use Node 18 for best compatibility with legacy `grpc` dependency.
- Backend supports direct loading from `client/node/biostar` files even if package entrypoint is missing.
- Set `GSDK_GATEWAY` (example: `127.0.0.1:4000`) to enable actual gateway test calls.
- Added `gsdk-sidecar` service (Node 14) dedicated to legacy G-SDK/grpc loading.
- Backend queries sidecar via `GSDK_SIDECAR_URL` for G-SDK status and `/api/devices/test`.
- `GSDK_USE_SSL=false` keeps local dev on insecure mode.
- `GSDK_DEVICE_PORT=51211` sets default non-SSL device/gateway port.

## Pull an Ollama model (optional)

```bash
docker exec -it expo-fr-ollama ollama pull llama3.2
```

## Seed starter data

After MongoDB is running, seed sample data for dashboard/API:

```bash
npm run seed
```
