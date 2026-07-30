#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-portainer-run:local}"
NAME="${NAME:-portainer-run}"
# Host port for the container's plain-HTTP listener; override e.g. HOST_PORT=3000
HOST_PORT="${HOST_PORT:-8080}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

echo "Building ${IMAGE}…"
docker build -t "$IMAGE" .

echo "Removing existing container ${NAME} (if any)…"
docker rm -f "$NAME" 2>/dev/null || true

echo "Starting ${NAME} (http://localhost:${HOST_PORT}/)…"
ENV_FILE_ARGS=()
if [[ -f "$ENV_FILE" ]]; then
  echo "Using --env-file ${ENV_FILE}"
  ENV_FILE_ARGS+=(--env-file "$ENV_FILE")
else
  echo "No env file at ${ENV_FILE} (set ENV_FILE or create .env to inject variables)"
fi
# shellcheck disable=SC2086
docker run -d \
  --name "$NAME" \
  -p "${HOST_PORT}:8080" \
  "${ENV_FILE_ARGS[@]}" \
  ${DOCKER_RUN_EXTRA:-} \
  "$IMAGE"

echo "Done. Logs: docker logs -f ${NAME}"
