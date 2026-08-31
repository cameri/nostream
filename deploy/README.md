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
chown 1000:1000 /opt/nostream/.nostr/settings.yaml
chmod 600 /opt/nostream/.nostr/settings.yaml
docker compose up -d
```

Or use the admin API/UI once `admin.enabled` is configured.

## Verify

```bash
docker compose ps
curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:8008/
```

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
