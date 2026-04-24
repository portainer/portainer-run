#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-portainer-run:local}"
NAME="${NAME:-portainer-run}"
# Host ports default to non-privileged values; override e.g. HOST_HTTPS=443 HOST_HTTP=80
HOST_HTTPS="${HOST_HTTPS:-9443}"
HOST_HTTP="${HOST_HTTP:-9080}"

echo "Building ${IMAGE}…"
docker build -t "$IMAGE" .

echo "Removing existing container ${NAME} (if any)…"
docker rm -f "$NAME" 2>/dev/null || true

echo "Starting ${NAME} (https://localhost:${HOST_HTTPS}/)…"
# shellcheck disable=SC2086
docker run -d \
  --name "$NAME" \
  -p "${HOST_HTTPS}:443" \
  -p "${HOST_HTTP}:80" \
  ${DOCKER_RUN_EXTRA:-} \
  "$IMAGE"

echo "Done. Logs: docker logs -f ${NAME}"
