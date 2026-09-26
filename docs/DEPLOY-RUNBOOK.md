# Deploy runbook (sandbox / production relay)

Step-by-step procedure for updating a running nostream host after a new
`ghcr.io/cameri/nostream:main` image is available. Use this **before** automating
deploys or adding HAProxy blue/green cutover.

For initial host setup see [`deploy/README.md`](../deploy/README.md). For how
images are published see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md).

## Architecture today

```text
GitHub push to main
  → CI builds and publishes ghcr.io/cameri/nostream:main
  → (optional) webhook pull stack downloads the image to the host
  → operator runs this runbook to migrate + recreate the relay
  → Cloudflare Tunnel / reverse proxy continues pointing at the relay port
```

The webhook pull stack **loads new images only**. It does **not** recreate the
relay container or run migrations. That gap is what this runbook closes.

## Roles of health endpoints

| Endpoint | Use during deploy |
|----------|-------------------|
| `/healthz` | Liveness — process is up (always `200` while running) |
| `/readyz` | Readiness — Postgres **and** Redis respond (`200` or `503`) |

Wait for `/readyz` to return `200` before sending user traffic to a new instance.
When HAProxy blue/green is added later, point backend health checks at `/readyz`
with `timeout check 5s` (dependency pings default to 3s inside the relay).

## Prerequisites

- Host bootstrapped (`deploy/bootstrap.sh /opt/nostream`)
- New relay image already on the host (`docker pull` or `docker load`)
- Shell access to the host (`cd /opt/nostream`)
- Optional: note the previous image ID for rollback

```bash
docker image inspect ghcr.io/cameri/nostream:main --format '{{.Id}}' | tee /tmp/nostream-pre-deploy-image-id
```

## Standard deploy (manual)

Run from the repository checkout (for scripts) or directly on the host.

### 1. Refresh release-managed files (when compose or postgres config changed)

```bash
./deploy/bootstrap.sh /opt/nostream
```

Existing `.env` and `.nostr/settings.yaml` are preserved.

### 2. Load the new image (skip if webhook pull stack already did)

```bash
docker pull ghcr.io/cameri/nostream:main
```

On hosts that cannot reach GHCR over IPv4, build or pull elsewhere, then
`docker save` → transfer → `docker load`. See
[`deploy/README.md`](../deploy/README.md#image-delivery-on-restricted-networks).

### 3. Run migrations and recreate the relay

```bash
chmod +x deploy/recreate-relay.sh
./deploy/recreate-relay.sh /opt/nostream
```

Or run the steps manually:

```bash
cd /opt/nostream
docker compose up --no-deps --force-recreate --abort-on-container-exit nostream-migrate
docker compose up -d --force-recreate --no-deps nostream
```

### 4. Verify

```bash
cd /opt/nostream
docker compose ps
curl -sf http://127.0.0.1:8008/readyz
echo
curl -sf http://127.0.0.1:8008/healthz
curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:8008/
```

Expected:

- `nostream-migrate` — exited `0`
- `nostream` — `running`
- `/readyz` — HTTP `200`, `"status":"ok"`, database and redis `"ok": true`
- NIP-11 root — JSON with relay metadata

If admin is enabled, also check `/admin/health` through your normal auth path.

### 5. Watch logs (first few minutes)

```bash
cd /opt/nostream
docker compose logs -f --tail=100 nostream
```

## Rollback

When the new relay fails readiness or behaves incorrectly:

### 1. Stop the bad relay

```bash
cd /opt/nostream
docker compose stop nostream
```

### 2. Restore the previous image

If you saved the pre-deploy image ID:

```bash
PREVIOUS_IMAGE="$(cat /tmp/nostream-pre-deploy-image-id)"
docker tag "$PREVIOUS_IMAGE" ghcr.io/cameri/nostream:main
```

Or load a known-good tarball:

```bash
docker load -i /path/to/nostream-main-backup.tar.gz
```

### 3. Recreate on the old image

```bash
./deploy/recreate-relay.sh /opt/nostream
```

Do **not** re-run migrations against a downgraded image unless you know the
schema is backward compatible.

## Troubleshooting

### `/readyz` stays `503`

- Check Postgres and Redis: `docker compose ps`
- Inspect relay logs: `docker compose logs nostream --tail=200`
- Confirm `.env` credentials match the running database and cache
- Increase probe patience: readiness pings use `ADMIN_DEPENDENCY_PING_TIMEOUT_MS`
  (default 3s)

### `nostream-migrate` exits non-zero

- Read migrate logs: `docker compose logs nostream-migrate`
- Do not force-recreate the relay until migrate succeeds
- Escalate if a migration is destructive — expand/contract migrations should be
  deployed in compatible order

### Image pull fails (GHCR / IPv6)

- Use `docker save` / `docker load` from a machine that can reach GHCR
- Keep `pull_policy: never` on nostream services in compose when using pre-loaded
  images

### Relay up but clients cannot connect

- Confirm the tunnel or reverse proxy still targets `127.0.0.1:8008`
- Webhook stack changes do not replace this runbook — they only deliver images

## What comes next (not in this runbook)

These are planned follow-ups on the zero-downtime track:

1. **Graceful WebSocket drain** — stop accepting new connections on shutdown,
   close existing clients cleanly (SIGTERM handling)
2. **HAProxy blue/green** — two relay backends, cutover via `/readyz`, documented
   in a future compose overlay
3. **Automated recreate** — wire post-pull steps into the webhook pipeline after
   the manual runbook is proven on sandbox

Until then, run this procedure after every image update.
