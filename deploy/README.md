# Production deployment

Minimal Docker Compose stack for running nostream in production. The relay
container uses a pre-built image from GHCR instead of building on the server.

This guide assumes a Linux host with Docker Engine and the Compose plugin
installed. Container images are published automatically after CI succeeds on pushes to
`main`. See [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for the CI/CD flow.

Migrations ship inside that image (`migrations/` and `knexfile.js`). The
`nostream-migrate` service is a one-shot container of the same image that
runs `knex migrate:latest` before the relay starts.

## Prerequisites

Before deploying the compose stack:

1. Install [Docker Engine](https://docs.docker.com/engine/install/) and the
   Compose plugin on the host.
2. Create a deploy directory (for example `/opt/nostream`).
3. Copy `deploy/docker-compose.prod.yml` to `docker-compose.yml` in that directory.
4. Copy `deploy/settings.yaml.example` to `.nostr/settings.yaml` and edit for
   your relay.
5. Create `.env` from `deploy/env.example` with production secrets.
6. Copy `postgresql.conf` from the repository root into the deploy directory.
7. Load `ghcr.io/cameri/nostream:main` on the host (see
   [Image delivery on restricted networks](#image-delivery-on-restricted-networks)
   if `docker pull` fails).

Do not copy `migrations/` or `knexfile.js` onto the host. Compose does not
mount them; changing files on disk will not change what the migrate service
runs.

## Server layout

```
/opt/nostream/
├── docker-compose.yml      # copy from deploy/docker-compose.prod.yml
├── .env                    # secrets (never commit)
├── .nostr/
│   ├── settings.yaml       # copy from deploy/settings.yaml.example
│   └── data/               # Postgres data (created on first start)
└── postgresql.conf         # from repository root
```

## Services

| Service           | Image                          | Notes                                                      |
|-------------------|--------------------------------|------------------------------------------------------------|
| nostream          | ghcr.io/cameri/nostream:main   | `pull_policy: never` when the image is pre-loaded          |
| nostream-db       | postgres:15                    |                                                            |
| nostream-cache    | redis:7.0.5-alpine3.16         |                                                            |
| nostream-migrate  | ghcr.io/cameri/nostream:main   | one-shot `knex migrate:latest`; same image as the relay    |

The relay listens on `127.0.0.1:8008` by default. Expose it publicly with a
reverse proxy or tunnel (for example Cloudflare Tunnel) in front of that address.

The relay service waits for `nostream-migrate` to exit 0
(`service_completed_successfully`) before it starts.

## Deploy

```bash
cd /opt/nostream

mkdir -p .nostr/data .nostr/db-logs
chmod 755 .nostr
chown 1000:1000 .nostr/settings.yaml
chmod 600 .env .nostr/settings.yaml

docker pull postgres:15
docker pull redis:7.0.5-alpine3.16

docker compose up -d
docker compose logs -f nostream-migrate
docker compose logs -f nostream
```

## Verify

```bash
docker compose ps
curl -s http://127.0.0.1:8008/
curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:8008/
```

The second command should return NIP-11 relay metadata JSON.

## Image delivery on restricted networks

Some hosts cannot reach GHCR over IPv4. Workarounds:

- **nostream image:** build or pull elsewhere, then `docker save` → transfer →
  `docker load` on the server. Keep `pull_policy: never` on the nostream and
  nostream-migrate services. One image is enough; migrations are already in it.
- **postgres / redis:** usually available from Docker Hub; if not, use the same
  save/load approach.

## Settings file permissions

The nostream container runs as the `node` user (uid 1000). Ensure
`.nostr/settings.yaml` is owned by uid 1000 and readable by that user:

```bash
chown 1000:1000 .nostr/settings.yaml
chmod 600 .nostr/settings.yaml
```

Without this, the relay falls back to default settings from the image.

## Updating

When a new image is available:

```bash
docker pull ghcr.io/cameri/nostream:main   # or: docker load -i nostream-main.tar.gz
docker compose up -d
```

`pull_policy: never` means Compose will not fetch a new digest by itself.
Load or pull the image first, then `up`. Compose recreates containers whose
image id changed, so `nostream-migrate` runs `migrate:latest` against the
schema baked into that image (no-op when already applied).

If migrate does not re-run after a load, recreate it explicitly:

```bash
docker compose up -d --force-recreate nostream-migrate nostream
```
