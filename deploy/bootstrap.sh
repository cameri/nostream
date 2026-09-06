#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a production nostream host from this repository's deploy/ directory.
#
# Usage:
#   ./deploy/bootstrap.sh [/opt/nostream]
#
# Creates the server layout, copies release-managed files from deploy/, and
# prepares .env for secrets. settings.yaml is optional — the relay uses image
# defaults until you add overrides (admin UI/API or .nostr/settings.yaml).

TARGET="${1:-/opt/nostream}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "error: required file not found: $1" >&2
    exit 1
  fi
}

require_file "$SCRIPT_DIR/docker-compose.prod.yml"
require_file "$SCRIPT_DIR/env.example"
require_file "$REPO_ROOT/postgresql.conf"

mkdir -p "$TARGET/.nostr/data" "$TARGET/.nostr/db-logs"

install -m 644 "$SCRIPT_DIR/docker-compose.prod.yml" "$TARGET/docker-compose.yml"
install -m 644 "$REPO_ROOT/postgresql.conf" "$TARGET/postgresql.conf"

if [[ ! -f "$TARGET/.env" ]]; then
  install -m 600 "$SCRIPT_DIR/env.example" "$TARGET/.env"
  echo "Created $TARGET/.env — edit secrets before starting the stack."
else
  echo "Keeping existing $TARGET/.env"
fi

if [[ ! -f "$TARGET/.nostr/settings.yaml" ]]; then
  echo "No settings.yaml created — relay will use defaults from the container image."
  echo "Add overrides later via the admin API or copy deploy/settings.yaml.example."
else
  echo "Keeping existing $TARGET/.nostr/settings.yaml"
fi

# The relay container runs as node (uid 1000) and writes settings.yaml, backups,
# and the audit log directly under .nostr. Deliberately not recursive: .nostr/data
# and .nostr/db-logs are owned by the postgres image's own user.
if [[ "$(id -u)" -eq 0 ]]; then
  chown 1000:1000 "$TARGET/.nostr"
fi

chmod 755 "$TARGET/.nostr"

cat <<EOF

Bootstrap complete: $TARGET

Next steps:
  1. Edit $TARGET/.env (SECRET, DB_PASSWORD, REDIS_PASSWORD)
  2. Load ghcr.io/cameri/nostream:main on this host
  3. cd $TARGET && docker compose up -d

Optional relay overrides:
  cp $SCRIPT_DIR/settings.yaml.example $TARGET/.nostr/settings.yaml
  chown 1000:1000 $TARGET/.nostr/settings.yaml
  chmod 600 $TARGET/.nostr/settings.yaml

EOF
