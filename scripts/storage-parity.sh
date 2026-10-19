#!/bin/sh
# The storage-parity oracle: the 37 sqlx migrations, the differential 51-method replay and the
# unmodified TypeScript relay's Cucumber suite, all against databases this script creates.
#
# Usage: scripts/storage-parity.sh
#
# Environment (no host address or private path is committed; set these per host):
#   PARITY_BIND           host address the published ports bind to. Default 127.0.0.1, so
#                         nothing is reachable off-host. On a host where the harness runs
#                         from another machine (this workspace's sandbox talks to the daemon
#                         host) set the address that machine reaches, e.g. the tailnet one.
#   PARITY_HOST           host the harness dials. Default $PARITY_BIND.
#   PARITY_PG_PORT        published Postgres port (default 18776)
#   PARITY_REDIS_PORT     published Redis port (default 18777)
#   PARITY_PG_PASSWORD    Postgres password; generated per run (openssl rand -hex 16) if unset
#   PARITY_REDIS_PASSWORD Redis password; generated per run if unset
#   NODE_PATH             node_modules with cucumber-js and ts-node; required unless
#                         CUCUMBER_BIN is set
#   CUCUMBER_BIN          cucumber-js binary (default $NODE_PATH/.bin/cucumber-js)
#
# Preflight: with a local Docker daemon, PARITY_BIND=127.0.0.1 is right; with a remote
# daemon (DOCKER_HOST=tcp://…) it refuses, because the daemon's loopback is not this
# machine's. The published port is then probed with a three-second timeout, and the
# connection-failure redaction test runs before any container exists.
#
# Both containers carry the `org.testcontainers=true` label the sandbox's Docker policy
# requires, publish their port on PARITY_BIND only (never a wildcard), use per-run
# credentials, and are removed by the exit trap. Nothing is written outside the worktree.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$root"

PARITY_BIND=${PARITY_BIND:-127.0.0.1}
PARITY_HOST=${PARITY_HOST:-$PARITY_BIND}
PARITY_PG_PORT=${PARITY_PG_PORT:-18776}
PARITY_REDIS_PORT=${PARITY_REDIS_PORT:-18777}
PARITY_PG_PASSWORD=${PARITY_PG_PASSWORD:-$(openssl rand -hex 16)}
PARITY_REDIS_PASSWORD=${PARITY_REDIS_PASSWORD:-$(openssl rand -hex 16)}

if [ -z "${CUCUMBER_BIN:-}" ]; then
    if [ -z "${NODE_PATH:-}" ]; then
        echo "storage-parity: set CUCUMBER_BIN or NODE_PATH to a node_modules with cucumber-js" >&2
        exit 64
    fi
    CUCUMBER_BIN="$NODE_PATH/.bin/cucumber-js"
fi

pg_container="nostream-parity-pg-$$"
redis_container="nostream-parity-redis-$$"
admin_url="postgres://postgres:$PARITY_PG_PASSWORD@$PARITY_HOST:$PARITY_PG_PORT/postgres"

cleanup() {
    docker rm -f "$pg_container" "$redis_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT HUP TERM

fail() {
    echo "storage-parity: $1" >&2
    exit 1
}

# Docker accepts a bracketed IPv6 address in `-p`; strip one bracket pair so the loopback
# and wildcard tests see the address itself.
unbracket() {
    case "$1" in
        \[*\]) address=${1#\[}; printf '%s' "${address%\]}" ;;
        *) printf '%s' "$1" ;;
    esac
}

is_loopback() {
    case "$(unbracket "$1")" in
        127.*|localhost|::1) return 0 ;;
        *) return 1 ;;
    esac
}

# Only a TCP (or SSH) daemon endpoint can be on another machine. A unix socket, a bare
# socket path, fd:// and npipe:// all name a daemon on this machine, and tcp://[::1] is the
# local loopback spelled in brackets.
is_remote_daemon() {
    case "${DOCKER_HOST:-}" in
        tcp://*|ssh://*)
            daemon=${DOCKER_HOST#*://}
            case "$daemon" in
                \[*) daemon=${daemon#\[}; daemon=${daemon%%\]*} ;;
                *) daemon=${daemon%%:*} ;;
            esac
            ! is_loopback "$daemon"
            ;;
        *) return 1 ;;
    esac
}

# Preflight, before any container exists. A wildcard bind is never right, and a loopback
# bind is right only for a daemon on this machine. No default guesses a daemon's address.
case "$(unbracket "$PARITY_BIND")" in
    0.0.0.0|'::'|'::0'|'0:0:0:0:0:0:0:0'|'*')
        fail "PARITY_BIND=$PARITY_BIND is a wildcard: publish on one address (127.0.0.1 for a local daemon, or the daemon host's reachable address)"
        ;;
esac
if is_loopback "$PARITY_BIND" && is_remote_daemon; then
    fail "PARITY_BIND=$PARITY_BIND is this machine's loopback, but the Docker daemon is remote (DOCKER_HOST=$DOCKER_HOST): set PARITY_BIND and PARITY_HOST to an address the daemon host accepts and this machine can reach"
fi
docker version >/dev/null 2>&1 \
    || fail "the Docker daemon at ${DOCKER_HOST:-/var/run/docker.sock} is not reachable"

# A forced connection failure must not echo the credential; the test fails if it does, and
# the run fails if the test was renamed away instead of passing.
echo "== credential redaction"
redaction_output=$(./scripts/rust.sh cargo test -p nostream-storage --test migrations \
    a_failed_connection_does_not_echo_the_password -- --exact 2>&1) || {
    printf '%s\n' "$redaction_output"
    fail "the connection-failure log echoed a credential"
}
printf '%s\n' "$redaction_output" | grep -q 'test result: ok. 1 passed' || {
    printf '%s\n' "$redaction_output"
    fail "the credential-redaction test did not run (renamed?)"
}

# The dialed address, probed with a three-second timeout: a refusal here names the two
# variables instead of surfacing as a sqlx timeout later.
probe_dial() {
    node -e 'const net = require("net"); const s = net.connect({ host: process.argv[1], port: Number(process.argv[2]) }); s.setTimeout(3000); s.on("connect", () => { s.destroy(); process.exit(0) }); s.on("timeout", () => { s.destroy(); process.exit(1) }); s.on("error", () => process.exit(1))' "$PARITY_HOST" "$PARITY_PG_PORT"
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

echo "== containers (bound to $PARITY_BIND, per-run credentials)"
docker rm -f "$pg_container" "$redis_container" >/dev/null 2>&1 || true
docker create --name "$pg_container" --label org.testcontainers=true \
    -e POSTGRES_PASSWORD="$PARITY_PG_PASSWORD" -e POSTGRES_DB=postgres \
    -p "$PARITY_BIND:$PARITY_PG_PORT:5432" postgres:16-alpine >/dev/null
docker create --name "$redis_container" --label org.testcontainers=true \
    -p "$PARITY_BIND:$PARITY_REDIS_PORT:6379" redis:7-alpine \
    redis-server --requirepass "$PARITY_REDIS_PASSWORD" >/dev/null
docker start "$pg_container" "$redis_container" >/dev/null
wait_for_log "$pg_container" "database system is ready to accept connections"
wait_for_log "$redis_container" "Ready to accept connections"
attempts=0
until probe_dial; do
    attempts=$((attempts + 1))
    [ "$attempts" -ge 5 ] && fail "the published Postgres port is not reachable at $PARITY_HOST:$PARITY_PG_PORT: set PARITY_BIND and PARITY_HOST to an address this machine can dial (127.0.0.1 on the daemon host; the daemon host's reachable address from elsewhere)"
    sleep 1
done
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
[ -x "$CUCUMBER_BIN" ] || fail "cucumber-js not found at $CUCUMBER_BIN"
mkdir -p .test-reports/integration
DB_URI="postgres://postgres:$PARITY_PG_PASSWORD@$PARITY_HOST:$PARITY_PG_PORT/nostream_parity_cucumber" \
REDIS_URI="redis://:$PARITY_REDIS_PASSWORD@$PARITY_HOST:$PARITY_REDIS_PORT" \
NODE_PATH="${NODE_PATH:-}" \
TS_NODE_TRANSPILE_ONLY=true \
NODE_OPTIONS=--no-experimental-strip-types \
    "$CUCUMBER_BIN" --format summary \
    || fail "the cucumber suite failed"

echo "== storage-parity: all three steps passed"
