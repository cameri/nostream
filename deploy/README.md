# Production deploy (relay.tnsor.network)

Minimal Docker Compose stack for the Hetzner relay server. Uses a pre-built
GHCR image instead of building on the server.

## Layout on server

```
/opt/nostream/
├── docker-compose.yml      # copy from deploy/docker-compose.prod.yml
├── .env                    # secrets (never commit)
├── .nostr/
│   ├── settings.yaml       # copy from deploy/settings.yaml.example
│   └── data/               # Postgres data (created on first start)
├── migrations/             # from repo (Part 2)
├── knexfile.js             # from repo (Part 2)
└── postgresql.conf         # from repo (Part 2)
```

## Services

| Service           | Image                          | Notes                          |
|-------------------|--------------------------------|--------------------------------|
| nostream          | ghcr.io/cameri/nostream:main   | `pull_policy: never` on IPv6-only host |
| nostream-db       | postgres:15                    |                                |
| nostream-cache    | redis:7.0.5-alpine3.16         |                                |
| nostream-migrate  | nostream-migrate:local         | pre-built on a machine with npm access |

Relay binds to `127.0.0.1:8008` for Cloudflare tunnel (Part 5).

## IPv6-only server notes

- GHCR pull often fails (IPv4-only registry). Load the image manually:
  `docker save` on a machine with access → `scp` → `docker load` on server.
- Set `pull_policy: never` on the nostream service so Compose uses the loaded image.
- If `postgres`, `redis`, or `node` pulls fail, use the same save/load workaround.
- `nostream-migrate` cannot run `npm install` on the server. Build and load the
  migrate image from a machine with registry access:

  ```bash
  docker build --platform linux/amd64 -f deploy/Dockerfile.migrate -t nostream-migrate:local .
  docker save nostream-migrate:local | gzip > /tmp/nostream-migrate.tar.gz
  scp -6 /tmp/nostream-migrate.tar.gz ferryx@'[2a01:4f9:c015:13f4::1]':/opt/nostream/
  # on server:
  gunzip -c nostream-migrate.tar.gz | docker load
  ```

## Quick start (server)

Assumes Part 2 is complete (Docker, `/opt/nostream`, `.env`, nostream image loaded).

```bash
cd /opt/nostream
mkdir -p .nostr/data .nostr/db-logs
chmod 755 .nostr
chown 1000:1000 .nostr/settings.yaml
chmod 600 .env .nostr/settings.yaml

docker pull postgres:15
docker pull redis:7.0.5-alpine3.16
docker pull node:24-alpine

docker compose up -d
docker compose logs -f nostream-migrate
docker compose logs -f nostream
curl -s http://127.0.0.1:8008/ | head
```
