#!/bin/sh
# The storage-parity oracle: the 37 sqlx migrations, the differential 51-method replay and the
# unmodified TypeScript relay's Cucumber suite, all against databases this script creates.
#
# Usage: scripts/storage-parity.sh
#
# Environment:
#   PARITY_PG_PORT     published Postgres port (default 18776)
#   PARITY_REDIS_PORT  published Redis port (default 18777)
#   PARITY_HOST        host the published ports are reached on (default 100.106.134.5)
#   NODE_PATH          node_modules with cucumber-js and ts-node (default the primary checkout)
#   CUCUMBER_BIN       cucumber-js binary (default $NODE_PATH/.bin/cucumber-js)
#
# Both containers carry the `org.testcontainers=true` label the sandbox's Docker policy
# requires, publish their port instead of bind-mounting (the policy denies a /workspace
# source), and are removed by the exit trap. Nothing is written outside the worktree.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$root"

PARITY_PG_PORT=${PARITY_PG_PORT:-18776}
PARITY_REDIS_PORT=${PARITY_REDIS_PORT:-18777}
PARITY_HOST=${PARITY_HOST:-100.106.134.5}
NODE_ROOT=${NODE_PATH:-/workspace/projects/nostream/node_modules}
CUCUMBER_BIN=${CUCUMBER_BIN:-$NODE_ROOT/.bin/cucumber-js}

pg_container="nostream-parity-pg-$$"
redis_container="nostream-parity-redis-$$"
admin_url="postgres://postgres:postgres@$PARITY_HOST:$PARITY_PG_PORT/postgres"

cleanup() {
    docker rm -f "$pg_container" "$redis_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT HUP TERM

fail() {
    echo "storage-parity: $1" >&2
    exit 1
}

wait_for_log() {
    container=$1
    pattern=$2
    attempts=0
    until docker logs "$container" 2>&1 | grep -q "$pattern"; do
        attempts=$((attempts + 1))
        [ "$attempts" -ge 90 ] && fail "$container did not report: $pattern"
        sleep 1
    done
}

echo "== containers"
docker rm -f "$pg_container" "$redis_container" >/dev/null 2>&1 || true
docker create --name "$pg_container" --label org.testcontainers=true \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres \
    -p "$PARITY_PG_PORT:5432" postgres:16-alpine >/dev/null
docker create --name "$redis_container" --label org.testcontainers=true \
    -p "$PARITY_REDIS_PORT:6379" redis:7-alpine >/dev/null
docker start "$pg_container" "$redis_container" >/dev/null
wait_for_log "$pg_container" "database system is ready to accept connections"
wait_for_log "$redis_container" "Ready to accept connections"
echo "   postgres and redis are accepting connections on $PARITY_HOST"

echo "== migrations and schema parity"
./scripts/rust.sh env PARITY_ADMIN_URL="$admin_url" \
    cargo test -p nostream-storage --test migrations -- --ignored --test-threads=1 \
    || fail "the migrations target failed"

echo "== behavioural parity"
./scripts/rust.sh env PARITY_ADMIN_URL="$admin_url" \
    cargo test -p nostream-storage --test parity -- --ignored --test-threads=1 \
    || fail "the parity target failed"

echo "== cucumber on the sqlx-migrated schema"
[ -x "$CUCUMBER_BIN" ] || fail "cucumber-js not found at $CUCUMBER_BIN (set CUCUMBER_BIN or NODE_PATH)"
mkdir -p .test-reports/integration
DB_URI="postgres://postgres:postgres@$PARITY_HOST:$PARITY_PG_PORT/nostream_parity_cucumber" \
REDIS_URI="redis://$PARITY_HOST:$PARITY_REDIS_PORT" \
NODE_PATH="$NODE_ROOT" \
TS_NODE_TRANSPILE_ONLY=true \
NODE_OPTIONS=--no-experimental-strip-types \
    "$CUCUMBER_BIN" --format summary \
    || fail "the cucumber suite failed"

echo "== storage-parity: all three steps passed"
