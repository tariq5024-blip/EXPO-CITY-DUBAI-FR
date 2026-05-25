#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker-compose.prod.yml"
AI_ENABLED=0
PULL_MODEL=""

usage() {
  echo "Usage: ./deploy.sh [--ai] [--pull-model <model>] [--down-first]"
  echo
  echo "Options:"
  echo "  --ai                  Enable Ollama service profile"
  echo "  --pull-model <model>  Pull Ollama model after deploy (requires --ai)"
  echo "  --down-first          Run docker compose down before up"
  exit 1
}

DOWN_FIRST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ai)
      AI_ENABLED=1
      shift
      ;;
    --pull-model)
      [[ $# -lt 2 ]] && usage
      PULL_MODEL="$2"
      shift 2
      ;;
    --down-first)
      DOWN_FIRST=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown option: $1"
      usage
      ;;
  esac
done

if [[ -n "$PULL_MODEL" && "$AI_ENABLED" -ne 1 ]]; then
  echo "--pull-model requires --ai"
  exit 1
fi

echo "==> Validating required files"
[[ -f ".env" ]] || { echo "Missing .env"; exit 1; }
[[ -f "g-sdk-1.9.0.tar.gz" ]] || { echo "Missing g-sdk-1.9.0.tar.gz"; exit 1; }
[[ -f "frontend/public/company-logo.png" ]] || { echo "Missing frontend/public/company-logo.png"; exit 1; }
[[ -f "frontend/public/sidebar-logo.png" ]] || { echo "Missing frontend/public/sidebar-logo.png"; exit 1; }

if [[ "$DOWN_FIRST" -eq 1 ]]; then
  echo "==> Stopping existing stack"
  docker compose -f "$COMPOSE_FILE" down
fi

echo "==> Building and starting containers"
if [[ "$AI_ENABLED" -eq 1 ]]; then
  docker compose -f "$COMPOSE_FILE" --profile ai up --build -d
else
  docker compose -f "$COMPOSE_FILE" up --build -d
fi

echo "==> Container status"
docker compose -f "$COMPOSE_FILE" ps

if command -v curl >/dev/null 2>&1; then
  echo "==> Health checks"
  set +e
  curl -fsS "http://localhost:4000/api/health" >/dev/null && echo "Backend health: OK" || echo "Backend health: FAILED"
  curl -fsS "http://localhost:5173" >/dev/null && echo "Frontend: OK" || echo "Frontend: FAILED"
  set -e
else
  echo "curl not installed; skipping HTTP health checks."
fi

if [[ "$AI_ENABLED" -eq 1 && -n "$PULL_MODEL" ]]; then
  echo "==> Pulling Ollama model: $PULL_MODEL"
  docker exec -it expo-fr-ollama ollama pull "$PULL_MODEL"
fi

echo
echo "Deployment completed."
echo "Frontend: http://localhost:5173"
echo "Backend:  http://localhost:4000/api/health"
