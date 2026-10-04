#!/usr/bin/env bash
set -euo pipefail

# Recreate the single-relay stack (docker-compose.yml) after a new image is on
# the host. For HAProxy blue/green use rolling-relay-recreate.sh instead.
#
# Usage:
#   ./deploy/recreate-relay.sh [/opt/nostream]
#
# Runs migrations, recreates nostream, and waits for /readyz. Does not pull
# images — load the image first (manually or via the webhook pull stack).

TARGET="${1:-/opt/nostream}"
RELAY_PORT="${RELAY_PORT:-8008}"
READYZ_URL="http://127.0.0.1:${RELAY_PORT}/readyz"
READYZ_RETRIES="${READYZ_RETRIES:-30}"
READYZ_INTERVAL_SECONDS="${READYZ_INTERVAL_SECONDS:-2}"

if [[ ! -f "$TARGET/docker-compose.yml" ]]; then
  echo "error: $TARGET/docker-compose.yml not found — run deploy/bootstrap.sh first" >&2
  exit 1
fi

cd "$TARGET"

echo "Running migrations (nostream-migrate)..."
docker compose up --no-deps --force-recreate --abort-on-container-exit nostream-migrate

echo "Recreating relay (nostream)..."
docker compose up -d --force-recreate --no-deps nostream

echo "Waiting for /readyz..."
for attempt in $(seq 1 "$READYZ_RETRIES"); do
  if curl -sf "$READYZ_URL" >/dev/null; then
    echo "ready: $READYZ_URL"
    curl -s "$READYZ_URL"
    echo
    exit 0
  fi

  echo "attempt ${attempt}/${READYZ_RETRIES}: not ready yet"
  sleep "$READYZ_INTERVAL_SECONDS"
done

echo "error: relay did not become ready at $READYZ_URL" >&2
docker compose ps
exit 1
