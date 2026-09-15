#!/usr/bin/env bash
set -euo pipefail

# Rolling relay recreate for the HAProxy blue/green stack. Replaces one relay
# at a time so the other keeps serving traffic.
#
# Usage:
#   ./rolling-relay-recreate.sh [/opt/nostream]
#
# Load the new image and run migrations before calling this.

TARGET="${1:-.}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.haproxy.yml}"

cd "$TARGET"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "error: compose file not found: $TARGET/$COMPOSE_FILE" >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

for service in nostream-blue nostream-green; do
  if [[ -z "$(compose ps -q "$service")" ]]; then
    echo "Skipping $service (not running)"
    continue
  fi

  echo "Replacing $service..."
  compose stop "$service"
  compose rm -f "$service"
  compose up -d --no-deps --wait "$service"
done

echo "Rolling recreate complete"
