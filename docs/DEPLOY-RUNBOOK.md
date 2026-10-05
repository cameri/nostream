# Deploy runbook (sandbox / production relay)

Step-by-step procedure for updating a running nostream host after a new
`ghcr.io/cameri/nostream:main` image is available.

| Doc | Purpose |
|-----|---------|
| [`deploy/README.md`](../deploy/README.md) | Bootstrap, compose stacks, health endpoints, HAProxy setup |
| [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) | How CI publishes container images |

## Image delivery vs relay recreate

```text
GitHub push to main
  → CI publishes ghcr.io/cameri/nostream:main
  → (optional) webhook pull stack loads the image on the host
  → operator runs this runbook (migrate + recreate relay(s))
  → Cloudflare Tunnel / reverse proxy keeps pointing at 127.0.0.1:8008
```

The webhook pull stack **loads images only**. It does **not** run migrations or
recreate relay containers. This runbook closes that gap.

## Choose your stack

| Stack | Compose file | Update script | Downtime |
|-------|--------------|---------------|----------|
| Single relay (default bootstrap) | `docker-compose.yml` | [`deploy/recreate-relay.sh`](../deploy/recreate-relay.sh) | Brief while `nostream` recreates |
| HAProxy blue/green | `docker-compose.haproxy.yml` | [`deploy/rolling-relay-recreate.sh`](../deploy/rolling-relay-recreate.sh) | None when peer relay is healthy |

Do **not** run both stacks at once — both bind `127.0.0.1:8008`. Initial HAProxy
install and trusted-proxy settings are in
[`deploy/README.md`](../deploy/README.md#zero-downtime-updates-haproxy-bluegreen).

During any deploy, wait for `/readyz` to return `200` before treating the relay
as good. Endpoint behavior, fan-out checks, drain on SIGTERM, and probe timeouts
are documented under
[Health checks](../deploy/README.md#health-checks) in `deploy/README.md`.

## Prerequisites

- Host bootstrapped (`deploy/bootstrap.sh /opt/nostream`)
- New relay image on the host (`docker pull` or `docker load`)
- Shell access (`cd /opt/nostream`)
- Before loading a new image or recreating containers, record the **running**
  relay image (not `docker image inspect :main` after pull — that tag may already
  point at the new image)

```bash
cd /opt/nostream
RELAY_CID="$(docker compose ps -q nostream 2>/dev/null || true)"
if [[ -n "$RELAY_CID" ]]; then
  docker inspect "$RELAY_CID" --format '{{.Image}}' | tee /tmp/nostream-pre-deploy-image-id
else
  echo "warn: nostream is not running; save a known-good image tarball or ID manually" >&2
fi
```

HAProxy stack: capture from a running backend, e.g.
`docker compose -f docker-compose.haproxy.yml ps -q nostream-blue`.

## Shared steps (both stacks)

### 1. Refresh release-managed files (when release notes say so)

```bash
./deploy/bootstrap.sh /opt/nostream
```

Existing `.env` and `.nostr/settings.yaml` are preserved.

### 2. Load the new image (skip if webhook pull already did)

```bash
docker pull ghcr.io/cameri/nostream:main
```

On hosts that cannot reach GHCR over IPv4, use `docker save` / `docker load`. See
[`deploy/README.md`](../deploy/README.md#image-delivery-on-restricted-networks).

## Single-relay deploy

Bootstrap copies compose files to `/opt/nostream` but **not** `recreate-relay.sh`.
Run the script from a **git checkout**, or install it once on the host:

```bash
# From repository checkout:
chmod +x deploy/recreate-relay.sh
./deploy/recreate-relay.sh /opt/nostream

# Or on the host (after copying from the repo):
cp /path/to/nostream/deploy/recreate-relay.sh /opt/nostream/
chmod +x /opt/nostream/recreate-relay.sh
/opt/nostream/recreate-relay.sh /opt/nostream
```

Equivalent manual steps:

```bash
cd /opt/nostream
docker compose up --no-deps --force-recreate --exit-code-from nostream-migrate nostream-migrate
docker compose up -d --force-recreate --no-deps nostream
```

## HAProxy blue/green deploy

After the new image is loaded:

```bash
cd /opt/nostream
docker compose -f docker-compose.haproxy.yml run --rm nostream-migrate
./rolling-relay-recreate.sh
```

The rolling script replaces blue and green one at a time; the peer must stay up
and `/readyz` healthy. See
[`deploy/README.md`](../deploy/README.md#zero-downtime-updates-haproxy-bluegreen).

## Verify

```bash
cd /opt/nostream
docker compose ps   # or: docker compose -f docker-compose.haproxy.yml ps
curl -sf http://127.0.0.1:8008/readyz && echo
curl -sf http://127.0.0.1:8008/healthz
curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:8008/
```

Expected: migrate exited `0`, relay(s) running, `/readyz` HTTP `200` with
database and redis `"ok": true`, NIP-11 JSON at `/`.

If admin is enabled, also check `/admin/health` through your normal auth path.

### Watch logs (first few minutes)

```bash
docker compose logs -f --tail=100 nostream
# HAProxy stack: nostream-blue and/or nostream-green
```

## Rollback

When the new relay fails readiness or behaves incorrectly:

### 1. Stop the bad relay(s)

Single stack:

```bash
cd /opt/nostream
docker compose stop nostream
```

HAProxy stack: stop the relay you just replaced; leave the healthy peer running.

### 2. Restore the previous image

```bash
PREVIOUS_IMAGE="$(cat /tmp/nostream-pre-deploy-image-id)"
docker tag "$PREVIOUS_IMAGE" ghcr.io/cameri/nostream:main
```

Or `docker load -i /path/to/nostream-main-backup.tar.gz`.

### 3. Recreate on the old image (skip migrations)

Do **not** run the migrator from a downgraded image against an already-upgraded
database. Recreate the relay **without** migrations:

Single-relay:

```bash
cd /opt/nostream
SKIP_MIGRATE=1 /opt/nostream/recreate-relay.sh /opt/nostream
# or from checkout: SKIP_MIGRATE=1 ./deploy/recreate-relay.sh /opt/nostream
```

HAProxy: run migrate only when moving **forward** on a new image. For rollback,
retag the old image to `:main`, then replace relays with
`rolling-relay-recreate.sh` (it does not re-run `nostream-migrate`).

## Troubleshooting

### `/readyz` stays `503`

- Check Postgres and Redis: `docker compose ps`
- Inspect relay logs: `docker compose logs nostream --tail=200` (or blue/green)
- Confirm `.env` credentials match the running database and cache
- On HAProxy backends, confirm `relayBroadcast.ok` in `/readyz` when fan-out is enabled

### `nostream-migrate` exits non-zero

- Read migrate logs: `docker compose logs nostream-migrate`
- Do not recreate relay(s) until migrate succeeds
- Escalate if a migration is destructive — deploy compatible image order for expand/contract migrations

### Image pull fails (GHCR / IPv6)

- Use `docker save` / `docker load` from a machine that can reach GHCR
- Keep `pull_policy: never` on nostream services when using pre-loaded images

### Relay up but clients cannot connect

- Confirm tunnel or reverse proxy still targets `127.0.0.1:8008`
- Webhook image delivery alone does not replace this runbook

## Automation (out of scope here)

Wiring migrate + recreate into the webhook pipeline after this manual procedure
is proven on sandbox is a separate follow-up.
