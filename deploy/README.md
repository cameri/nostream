# Production deployment

Minimal Docker Compose stack for running nostream in production. The relay
container pulls a pre-built image from GHCR instead of building on the server.

This guide assumes a Linux host with Docker Engine and the Compose plugin
installed. Container images are published automatically after CI succeeds on pushes to
`main`. See [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) for the CI/CD flow.

## Prerequisites

Before deploying the compose stack:

1. Install [Docker Engine](https://docs.docker.com/engine/install/) and the
   Compose plugin on the host.
2. Create a deploy directory (for example `/opt/nostream`).
3. Copy `deploy/docker-compose.prod.yml` to `docker-compose.yml` in that directory.
4. Copy `deploy/settings.yaml.example` to `.nostr/settings.yaml` and edit for
   your relay.
5. Create `.env` from `deploy/env.example` with production secrets.
6. Copy from the repository root into the deploy directory:
   - `migrations/`
   - `knexfile.js`
   - `postgresql.conf`
7. Load `ghcr.io/cameri/nostream:main` on the host (see
   [Image delivery on restricted networks](#image-delivery-on-restricted-networks)
   if `docker pull` fails).

## Server layout

```
/opt/nostream/
├── docker-compose.yml      # copy from deploy/docker-compose.prod.yml
├── .env                    # secrets (never commit)
├── .nostr/
│   ├── settings.yaml       # copy from deploy/settings.yaml.example
│   └── data/               # Postgres data (created on first start)
├── migrations/             # from repository root
├── knexfile.js             # from repository root
└── postgresql.conf         # from repository root
```

## Services

| Service           | Image                          | Notes                                       |
|-------------------|--------------------------------|---------------------------------------------|
| nostream          | ghcr.io/cameri/nostream:main   | `pull_policy: never` when image is pre-loaded |
| nostream-db       | postgres:15                    |                                             |
| nostream-cache    | redis:7.0.5-alpine3.16         |                                             |
| nostream-migrate  | nostream-migrate:local         | pre-built; see migrate image build below    |

The relay listens on `127.0.0.1:8008` by default. Expose it publicly with a
reverse proxy or tunnel (for example Cloudflare Tunnel) in front of that address.

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

## Migrate image

The migrate service expects a local image tagged `nostream-migrate:local`. Build
it on a machine with registry access (use `linux/amd64` when building on Apple
Silicon):

```bash
docker build --platform linux/amd64 -f deploy/Dockerfile.migrate -t nostream-migrate:local .
docker save nostream-migrate:local | gzip > nostream-migrate.tar.gz
```

Transfer and load on the server:

```bash
gunzip -c nostream-migrate.tar.gz | docker load
```

## Image delivery on restricted networks

Some hosts cannot reach GHCR or npm over IPv4. Workarounds:

- **nostream image:** build or pull elsewhere, then `docker save` → transfer →
  `docker load` on the server. Keep `pull_policy: never` on the nostream service.
- **postgres / redis:** usually available from Docker Hub; if not, use the same
  save/load approach.
- **migrations:** use the pre-built migrate image above instead of running
  `npm install` on the server.

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
docker load -i nostream-main.tar.gz   # if not pulling from GHCR
docker compose up -d
```

Migrations re-run automatically via the `nostream-migrate` service on each
`docker compose up`.
