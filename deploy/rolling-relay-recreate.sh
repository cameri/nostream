#!/usr/bin/env bash
set -euo pipefail

# Rolling relay recreate for the HAProxy blue/green stack. Replaces one relay
# at a time so the other keeps serving traffic.
#
# Usage:
#   ./rolling-relay-recreate.sh [/opt/nostream]
#
# Load the new image and run migrations before calling this.

TARGET="${1:-/opt/nostream}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.haproxy.yml}"
RELAY_PORT="${RELAY_PORT:-8008}"

cd "$TARGET"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "error: compose file not found: $TARGET/$COMPOSE_FILE" >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

relay_readyz_ok() {
  local service=$1
  local cid
  cid="$(compose ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$cid" ]]; then
    return 1
  fi
  docker exec "$cid" node -e \
    "fetch('http://127.0.0.1:${RELAY_PORT}/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}

peer_for() {
  case "$1" in
    nostream-blue) echo nostream-green ;;
    nostream-green) echo nostream-blue ;;
    *) echo "error: unknown service $1" >&2; exit 1 ;;
  esac
}

require_healthy_peer() {
  local peer=$1
  if [[ -z "$(compose ps -q "$peer")" ]]; then
    echo "error: peer $peer is not running; start it before replacing the other relay" >&2
    exit 1
  fi
  if ! relay_readyz_ok "$peer"; then
    echo "error: peer $peer /readyz is not healthy; fix it before continuing" >&2
    exit 1
  fi
}

for service in nostream-blue nostream-green; do
  if [[ -z "$(compose ps -q "$service")" ]]; then
    echo "Starting $service (not running)..."
    compose rm -f "$service" >/dev/null 2>&1 || true
    compose up -d --no-deps --wait "$service"
    continue
  fi

  require_healthy_peer "$(peer_for "$service")"

  echo "Replacing $service..."
  compose stop "$service"
  compose rm -f "$service"
  compose up -d --no-deps --wait "$service"
done

echo "Rolling recreate complete"
