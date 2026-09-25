# Production deployment

Minimal Docker Compose stack for running nostream in production. The relay
uses a pre-built image from GHCR; migrations and default settings ship inside
that image.

This guide assumes a Linux host with Docker Engine and the Compose plugin
installed. Container images are published automatically after CI succeeds on pushes to
`main`. See [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for the CI/CD flow.

## What the server keeps locally

| Path | Required | Changes with releases? |
|------|----------|------------------------|
| `.env` | **Yes** | No — your secrets and tuning |
| `.nostr/data/` | Created at runtime | No — Postgres data |
| `docker-compose.yml` | Yes (via bootstrap) | **Yes** — re-run bootstrap or PR 2 auto-sync |
| `postgresql.conf` | Yes (via bootstrap) | Rarely |
| `.nostr/settings.yaml` | **Optional** | Your overrides only |

**Do not copy** onto the host: `migrations/`, `knexfile.js`, or a full
`settings.yaml` from older docs. Migrations run from the image; settings
defaults come from the image and merge with any optional overrides file.

## Quick start

From a git checkout on the server (or after copying the `deploy/` folder):

```bash
chmod +x deploy/bootstrap.sh
./deploy/bootstrap.sh /opt/nostream
```

Edit `/opt/nostream/.env`, load `ghcr.io/cameri/nostream:main`, then:

```bash
cd /opt/nostream
docker compose up -d
```

Bootstrap copies release-managed files (`docker-compose.yml`, `postgresql.conf`)
from this repository. You only maintain `.env` and optional settings overrides.

## Prerequisites

1. [Docker Engine](https://docs.docker.com/engine/install/) and the Compose plugin
2. `ghcr.io/cameri/nostream:main` loaded on the host (see
   [Image delivery](#image-delivery-on-restricted-networks) if `docker pull` fails)

## Server layout after bootstrap

```
/opt/nostream/
├── docker-compose.yml      # from deploy/docker-compose.prod.yml
├── postgresql.conf         # from repository root
├── .env                    # secrets (never commit)
└── .nostr/
    ├── settings.yaml       # optional overrides only
    └── data/               # Postgres data (created on first start)
```

## Services

| Service           | Image                          | Notes                                                   |
|-------------------|--------------------------------|---------------------------------------------------------|
| nostream          | ghcr.io/cameri/nostream:main   | `pull_policy: never` when the image is pre-loaded       |
| nostream-db       | postgres:15                    |                                                         |
| nostream-cache    | redis:7.0.5-alpine3.16         |                                                         |
| nostream-migrate  | ghcr.io/cameri/nostream:main   | one-shot `knex migrate:latest`; same image as the relay |

The relay listens on `127.0.0.1:8008`. Expose it with a reverse proxy or
tunnel (for example Cloudflare Tunnel).

The relay waits for `nostream-migrate` to exit 0 before it starts.

## Settings

Without `.nostr/settings.yaml`, the relay uses `resources/default-settings.yaml`
from the container image. When a release adds new settings keys, they appear
automatically from the image defaults.

To override specific values:

```bash
cp deploy/settings.yaml.example /opt/nostream/.nostr/settings.yaml
# edit overrides only — not a full copy of default-settings.yaml
# the relay also writes backups and the audit log into .nostr itself, so the
# directory needs to be writable by uid 1000, not just the settings file
chown 1000:1000 /opt/nostream/.nostr /opt/nostream/.nostr/settings.yaml
chmod 600 /opt/nostream/.nostr/settings.yaml
docker compose up -d
```

Or use the admin API/UI once `admin.enabled` is configured.

## Verify

```bash
docker compose ps
curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:8008/
curl -s http://127.0.0.1:8008/readyz
```

## Health checks

Use the relay HTTP port (default `8008`) for deploy and load-balancer probes:

| Endpoint   | Type       | Behavior                                                 | Typical use                   |
|------------|------------|----------------------------------------------------------|-------------------------------|
| `/healthz` | Liveness   | Always `200 OK` if the process is running                | Restart unhealthy containers  |
| `/readyz`  | Readiness  | `200` when Postgres and Redis respond; `503` otherwise   | HAProxy blue/green cutover    |

`/readyz` is unauthenticated and intended for infrastructure. It reuses the same
Postgres and Redis checks as `/admin/health` without requiring admin auth.
Each dependency ping uses the default 3s timeout (`ADMIN_DEPENDENCY_PING_TIMEOUT_MS`).
Set your load balancer check timeout above that (for example HAProxy
`timeout check 5s`) so slow-but-healthy backends do not flap during probes.
Responses are cached in-process for 1s to absorb polling without hammering the DB pool.
Use readiness before routing traffic to a new instance during deploys. On
SIGTERM the relay sets `/readyz` to `503` with `"status":"draining"` while
the HTTP listener remains up, rejects new WebSocket connections, drains
existing clients, then closes (`WS_DRAIN_TIMEOUT_MS`, default 30s). Set
`stop_grace_period` above that timeout (reference compose uses 45s) so Docker
does not SIGKILL the container mid-drain.

## Image delivery on restricted networks

Some hosts cannot reach GHCR over IPv4:

- **nostream image:** build or pull elsewhere, then `docker save` → transfer →
  `docker load`. Keep `pull_policy: never` on nostream and nostream-migrate.
- **postgres / redis:** usually on Docker Hub; use save/load if needed.

## Updating

When a new image is available:

```bash
docker pull ghcr.io/cameri/nostream:main   # or: docker load -i nostream-main.tar.gz
docker compose up -d
```

If migrate does not re-run after a load:

```bash
docker compose up -d --force-recreate nostream-migrate nostream
```

When compose or `postgresql.conf` change in a release, re-run bootstrap against
the new checkout (or copy the updated files). Automated sync is planned separately.

## Refresh release-managed files

```bash
./deploy/bootstrap.sh /opt/nostream
```

Existing `.env` and `.nostr/settings.yaml` are preserved.

## Zero-downtime updates (HAProxy blue/green)

`deploy/docker-compose.haproxy.yml` replaces the single-relay stack with two
relays (`nostream-blue`, `nostream-green`) behind HAProxy on `127.0.0.1:8008`.
Postgres, Redis, and migrations are unchanged.

The HAProxy compose file **always sets `RELAY_BROADCAST_FANOUT=true` on relay
services** (even if bootstrap `.env` leaves it `false` for the single-relay
stack). Both relays publish accepted events to a shared Redis stream; each
cluster primary subscribes and fans out to its workers so live WebSocket clients
stay in sync when HAProxy balances across blue and green.

Do **not** run the single-relay `docker-compose.yml` stack and the HAProxy stack
at the same time: both bind `127.0.0.1:8008`. Stop the old stack before starting
blue/green:

```bash
cd /opt/nostream
docker compose down   # single-relay stack, if it was running
```

Install alongside `.env` and `postgresql.conf`, then start:

```bash
cp deploy/docker-compose.haproxy.yml deploy/rolling-relay-recreate.sh /opt/nostream/
cp -r deploy/haproxy /opt/nostream/
chmod +x /opt/nostream/rolling-relay-recreate.sh
cd /opt/nostream
docker compose -f docker-compose.haproxy.yml up -d
curl -s http://127.0.0.1:8008/readyz
```

HAProxy sets `X-Forwarded-For` (appended as the rightmost hop). In
`.nostr/settings.yaml` (or your settings overrides), trust the HAProxy address
from `docker-compose.haproxy.yml` (`172.28.0.2` on subnet `172.28.0.0/24`):

```yaml
network:
  remoteIpHeader: x-forwarded-for
  trustedProxies:
    - "172.28.0.2"
    - "127.0.0.1"
    - "::ffff:127.0.0.1"
    - "::1"
```

With a trusted proxy, the relay uses the **last** `X-Forwarded-For` hop (what
HAProxy appended), not the leftmost value clients may supply.

To update, load the new image, run migrations, then replace relays one at a time:

```bash
cd /opt/nostream
docker compose -f docker-compose.haproxy.yml run --rm nostream-migrate
./rolling-relay-recreate.sh
```

The script requires the peer relay to be running and `/readyz` healthy before it
stops either backend. It waits for each replacement to become healthy before
moving to the second relay. HAProxy health-checks `/readyz` every 2s and retries
failed requests on the other backend (`option redispatch`). Set
`STOP_GRACE_PERIOD` (default `45s`) above `WS_DRAIN_TIMEOUT_MS` (default 30s) so
WebSocket drain finishes before Docker sends SIGKILL.
