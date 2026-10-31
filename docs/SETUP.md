# Production Relay Setup Guide

> **Verified against:** nostream v3.6.2 (Ubuntu 24.04 LTS, Docker Engine 27+, Docker Compose v2)  
> **Maintenance:** Maintained in-tree and reviewed whenever changes land in `deploy/` or compose configurations.
>
> The steps below pull `:latest`, which may be newer than the version above. Pin a tag in both `docker-compose.yml` and the `docker pull` command (step 4) if you need a known version.

This is the canonical first-party guide for deploying and operating a production [nostream](https://github.com/cameri/nostream) Nostr relay. It covers host preparation, the automated deployment bootstrap, reverse proxy configuration with automatic TLS, verification, and ongoing maintenance.

---

## What You Need

Before you begin, ensure you have:

1. **A Linux host:** A VPS or dedicated server (Ubuntu 24.04 LTS or Debian 12 recommended) with at least:
   - 2 vCPUs
   - 4 GB RAM — the database configuration this repository ships is tuned for a ~16 GB host, so on 4 or 8 GB you have to size it down in step 3 before starting the stack
   - 20+ GB SSD disk space (PostgreSQL event store grows over time)
   - A public IPv4 address (and optional IPv6)
2. **A domain name:** A domain or subdomain you control (e.g. `relay.example.com`).
   - Create a DNS `A` record pointing `relay.example.com` to your server's IPv4 address.
   - If using IPv6, create an `AAAA` record pointing to your server's IPv6 address.
3. **Open firewall ports:**
   - Port `80` (HTTP, for ACME certificate issuance and redirect)
   - Port `443` (HTTPS / WSS, for secure client connections)
   - Port `22` (SSH, management)
4. **A few command-line tools** used later in this guide. `git` fetches the deployment files; `curl` and `openssl` generate your secrets and probe the relay; `jq` pretty-prints the JSON responses:
   ```bash
   sudo apt-get install -y git curl openssl jq
   ```
   Step 9's optional `npx nak` check needs Node.js 18 or newer (`sudo apt-get install -y nodejs npm`), installed only if you want that check; nothing else in this guide uses it.

---

## Common Traps to Avoid

If you have read older community guides, be aware of the following anti-patterns:

- **Do NOT expose port 8008 publicly:** The relay binds to `127.0.0.1:8008` by default. Only your local reverse proxy (Caddy or Nginx) should connect to it. Exposing port 8008 directly bypasses TLS and proxy connection limits.
- **Do NOT copy `migrations/` or `knexfile.js` to the host:** Database migrations are baked inside the container image and run automatically through a one-shot container (`nostream-migrate`) during startup.
- **Do NOT copy a full `settings.yaml` to the host:** The relay automatically loads defaults from `resources/default-settings.yaml` inside the image. You only need to supply the specific keys you wish to override. Creating a full copy prevents you from automatically receiving new settings defaults added in future releases.
- **Do NOT install Docker via Snap:** Snap Docker packages apply sandbox restrictions that can interfere with volume mounts and loopback socket networking. Use Docker's official apt/yum repositories.

---

## 1. Install Docker Engine and Compose

Install Docker Engine and the Compose plugin from the official Docker repository. The repository path differs by distribution — Debian and Ubuntu use separate trees, and pointing a Debian host at the Ubuntu tree makes `apt-get update` fail with a 404.

```bash
# Remove any conflicting packages
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
  sudo apt-get remove -y $pkg || true
done

# Add Docker's official GPG key. The distro is detected from /etc/os-release so this works on
# both Debian and Ubuntu; download.docker.com/linux/<distro> only exists for the matching OS.
source /etc/os-release
case "${ID}" in
  debian|ubuntu) DOCKER_DISTRO="${ID}" ;;
  *)
    echo "Unsupported distribution '${ID}'. Install Docker Engine manually; see https://docs.docker.com/engine/install/" >&2
    exit 1
    ;;
esac

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/${DOCKER_DISTRO}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository to Apt sources
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DOCKER_DISTRO} \
  ${VERSION_CODENAME} stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker packages
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Verify installation
docker --version
docker compose version
```

---

## 2. Get the Deployment Files

Clone the repository to retrieve the deployment scripts and release-managed configuration files:

```bash
git clone https://github.com/cameri/nostream.git ~/nostream
cd ~/nostream
```

---

## 3. Bootstrap the Deploy Root

Run the bootstrap script to create the server layout at `/opt/nostream`:

```bash
chmod +x deploy/bootstrap.sh
sudo ./deploy/bootstrap.sh /opt/nostream
```

This creates the production directory structure:

```text
/opt/nostream/
├── docker-compose.yml      # Copied from deploy/docker-compose.prod.yml
├── postgresql.conf         # Performance-tuned database config
├── .env                    # Environment secrets (mode 600)
└── .nostr/
    ├── data/               # PostgreSQL data directory (created at start)
    └── db-logs/            # PostgreSQL log directory
```

### Size the database for your host

The `postgresql.conf` that bootstrap installs is `postgresql.conf` from the repository root, tuned for a large host: `shared_buffers = 4GB`, `maintenance_work_mem = 1GB` and `effective_cache_size = 12GB`. Those are startup allocations, so on the 4 GB minimum host this guide recommends, PostgreSQL alone reserves the whole machine and the relay, Redis and the OS are left to the kernel's OOM killer.

On anything smaller than about 16 GB, lower the three values before you start the stack. These are safe for the stated minimum:

```bash
# 4 GB host. Use 2GB / 512MB / 6GB on an 8 GB host.
sudo sed -i \
  -e 's/^shared_buffers = .*/shared_buffers = 1GB/' \
  -e 's/^maintenance_work_mem = .*/maintenance_work_mem = 256MB/' \
  -e 's/^effective_cache_size = .*/effective_cache_size = 3GB/' \
  /opt/nostream/postgresql.conf
```

The rule of thumb behind those numbers: `shared_buffers` at 25% of RAM, `maintenance_work_mem` at RAM/16 up to 1 GB, and `effective_cache_size` at 50–75% of RAM. `postgresql.conf` is a release-managed file, so an update can overwrite your edits — the update section below says how to reapply them and how to make a running database pick them up.

If you raise the host size instead, run `free -g` and compare: the shipped values want a 16 GB machine, not 8.

---

## 4. Choose Your Relay Image

The production compose stack uses pre-built images from GitHub Container Registry (GHCR):

- `ghcr.io/cameri/nostream:latest` — Tracks the latest official release.
- `ghcr.io/cameri/nostream:vX.Y.Z` — Pins a specific release version (recommended for strict immutability, e.g. `ghcr.io/cameri/nostream:v3.6.2`).

Pull the image onto the server:

```bash
sudo docker pull ghcr.io/cameri/nostream:latest
```

**Note on `pull_policy`.** `docker-compose.yml` sets `pull_policy: never` on relay services so that Docker Compose does not attempt to pull during startup or flapping network conditions. You explicitly pull images when deploying or upgrading.

That also means **the tag in `docker-compose.yml` is the tag that runs.** Pulling `ghcr.io/cameri/nostream:v3.6.2` while the compose file still says `:latest` deploys `:latest`, not the version you pulled. To pin, set the same tag in both places:

```bash
sudo sed -i 's|ghcr.io/cameri/nostream:.*|ghcr.io/cameri/nostream:v3.6.2|' /opt/nostream/docker-compose.yml
sudo docker pull ghcr.io/cameri/nostream:v3.6.2
```

---

## 5. Configure Environment Variables

Edit `/opt/nostream/.env` with your editor of choice:

```bash
sudo nano /opt/nostream/.env
```

Generate secure secrets for the placeholders:

```bash
# Generate a secret for the SECRET variable:
openssl rand -hex 128

# Generate passwords for DB_PASSWORD and REDIS_PASSWORD:
openssl rand -hex 32
```

Update the values in `/opt/nostream/.env`:

```ini
SECRET=<paste-your-128-char-hex-secret-here>

DB_HOST=nostream-db
DB_PORT=5432
DB_USER=nostr_ts_relay
DB_PASSWORD=<paste-your-db-password-here>
DB_NAME=nostr_ts_relay

REDIS_HOST=nostream-cache
REDIS_PORT=6379
REDIS_USER=default
REDIS_PASSWORD=<paste-your-redis-password-here>

RELAY_PORT=8008
NOSTR_CONFIG_DIR=/home/node/.nostr

DB_MIN_POOL_SIZE=16
DB_MAX_POOL_SIZE=64
DB_ACQUIRE_CONNECTION_TIMEOUT=60000
WORKER_COUNT=2

RELAY_BROADCAST_FANOUT=false
RELAY_BROADCAST_STREAM_KEY=nostream:relay:broadcast
```

*(See [`CONFIGURATION.md`](../CONFIGURATION.md) for full descriptions of all environment variables.)*

---

## 6. Configure Relay Settings

Both the proxy settings below and any metadata overrides live in one file. Create it from the shipped example:

```bash
sudo cp ~/nostream/deploy/settings.yaml.example /opt/nostream/.nostr/settings.yaml
sudo chown 1000:1000 /opt/nostream/.nostr/settings.yaml
sudo chmod 600 /opt/nostream/.nostr/settings.yaml
```

### Proxy trust (required)

The relay binds to `127.0.0.1` and **cannot be exposed without a reverse proxy** (step 8), so this applies to every deployment. By default it trusts only loopback and leaves `network.remoteIpHeader` unset, so every request arrives carrying the proxy's address — or, for a published port, the Docker gateway that forwards it — and **all clients share one rate-limit bucket** — one busy client can rate-limit everyone else.

`deploy/settings.yaml.example` has no `network` section, so add one. Copy the default `trustedProxies` list **in full** and append to it — arrays are replaced wholesale by the settings merge, not appended, so a shortened list deletes addresses the image ships:

```yaml
network:
  # Which header the proxy sets. Both proxies in step 8 set X-Forwarded-For by default.
  remoteIpHeader: x-forwarded-for
  trustedProxies:
    - "127.0.0.1"
    - "::ffff:127.0.0.1"
    - "::1"
    - "10.10.10.1"
    - "::ffff:10.10.10.1"
    # Append your proxy's address if it is not one of the above.
```

The list above is the image default. Entries `10.10.10.x` come from the development `docker-compose.yml`, which pins its own subnet; the production compose publishes the relay on `127.0.0.1:8008` from its own bridge network (`nostream_default`), whose gateway no default entry covers.

Which address the relay sees depends on how your proxy reaches it, and matching is exact — no CIDR, no ranges — so work it out rather than guessing:

- **Proxy installed on the host** (the Caddy and Nginx setups below) connects to `127.0.0.1:8008`, but the relay does not see loopback: Docker forwards the published port, so the source is typically the compose network's gateway address, which is not in the default list. The debug line below reports the address the relay actually resolved. Read it and add it:
  ```bash
  sudo docker network inspect nostream_default --format '{{(index .IPAM.Config 0).Gateway}}'
  ```
- **Proxy in its own container** reaches the relay over the Docker network, so the source is the proxy container's own address. Read it, then add it:

```bash
sudo docker inspect <proxy-container> --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}}={{$cfg.IPAddress}} {{end}}'
```

```yaml
  trustedProxies:
    - "127.0.0.1"
    # ... keep the other defaults ...
    - "172.18.0.5"   # <-- your proxy container
```

The relay logs the address it resolved for each websocket client, but that line is written at `debug` level and the default is `info`, so it does not appear by default. Set `LOG_LEVEL=debug` in `/opt/nostream/.env`, restart, connect two different clients, then:

```bash
sudo docker compose -f /opt/nostream/docker-compose.yml logs nostream | grep -oE 'client [0-9a-f.:]+ connected:' | sort | uniq -c | sort -rn | head
```

Use two clients on **different public IP addresses** for this check: clients on the same home network or VPN legitimately share one address, so two identical values prove nothing there. Compare each logged address with that client's expected public IP. If both match their own address, proxy trust is working; if both show the same address, trust is not working — that is the collision this section prevents. Turn the log level back to `info` afterwards; `debug` logs request headers for every connection.

> `remoteIpHeader` set without a matching `trustedProxies` entry is silently ignored. The next client connection logs `WARNING: network.remoteIpHeader is set but network.trustedProxies is empty` at `warn`, which is visible at the default level — if that line appears, clients are not being identified individually. It is written per connection, not once at startup, so look for it with `sudo docker compose logs nostream | grep remoteIpHeader` while a client is connected.

### Relay metadata (optional)

To set your relay name, description, contact email or pubkey, **edit the `info` block that is already in the file** — do not add a second one. YAML rejects a duplicated key, and as above, a file that fails to parse is discarded entirely:

```yaml
info:
  relay_url: wss://relay.example.com
  name: "My Nostr Relay"
  description: "A community Nostr relay powered by nostream."
  pubkey: "<your-64-character-hex-nostr-pubkey>"
  contact: "mailto:operator@example.com"
```

Anything you omit falls back to `resources/default-settings.yaml` in the image.

**A malformed `settings.yaml` fails silently.** If the file does not parse, the relay logs the error and starts with the image defaults — so your relay name, proxy trust and every other override quietly disappear while the process still comes up healthy.

Do not rely on a log grep to catch this: `docker compose logs` shows only the current container's output, so after any restart the line is gone and silence proves nothing. Verify the *effective* settings instead, which is what the relay actually loaded:

```bash
curl -s -H 'Accept: application/nostr+json' http://127.0.0.1:8008/ | jq '{name, description}'
```

If `name` is `null` or shows the image default rather than the value you set, the file did not load. Note that the relay rewrites `settings.yaml` from the admin console, which drops comments but keeps values.

---

## 7. Start the Stack

Navigate to `/opt/nostream` and start the containers in the background:

```bash
cd /opt/nostream
sudo docker compose up -d
```

Verify that all services started successfully:

```bash
sudo docker compose ps
```

You should see:
- `nostream-cache`: Up and healthy (Redis)
- `nostream-db`: Up and healthy (PostgreSQL)
- `nostream-migrate`: Exited with status `0` (migrations completed)
- `nostream`: Up and running on `127.0.0.1:8008`

Verify readiness from the host loopback:

```bash
curl -s http://127.0.0.1:8008/healthz
curl -s http://127.0.0.1:8008/readyz
```

Expected output for `/readyz` (HTTP 200; the relay returns 503 when either dependency is down):
```json
{"status":"ok","database":{"ok":true},"redis":{"ok":true}}
```
The key is `redis`, not `cache`, and a healthy status is `ok`. When relay broadcast fanout is enabled an extra `relayBroadcast` key appears.

---

## 8. Put the Relay Behind TLS

The relay listens on `127.0.0.1:8008` and requires a reverse proxy to terminate TLS on port 443 and handle WebSocket upgrades.

Both options below depend on the proxy-trust settings from step 6. Without them the relay sees every client as the proxy — or, for a published port, the Docker gateway — and one busy client can rate-limit everyone else.

### Option A: Caddy (Recommended)

Caddy provides automatic HTTPS with Let's Encrypt certificates and native WebSocket proxying out of the box with zero boilerplate.

1. **Install Caddy:**
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update
   sudo apt install -y caddy
   ```

2. **Configure `/etc/caddy/Caddyfile`:**
   ```text
   relay.example.com {
       reverse_proxy 127.0.0.1:8008
   }
   ```

3. **Reload Caddy:**
   ```bash
   sudo systemctl reload caddy
   ```

Caddy automatically provisions your TLS certificate and proxies WebSocket traffic to the relay.

---

### Option B: Nginx + Certbot (Alternative)

If you already run Nginx:

1. **Install Nginx and Certbot:**
   ```bash
   sudo apt update
   sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. **Obtain certificate:**
   ```bash
   sudo certbot certonly --nginx -d relay.example.com
   ```

3. **Configure Nginx virtual host (`/etc/nginx/sites-available/nostream`):**
   ```nginx
   server {
       server_name relay.example.com;
       listen 80;
       listen [::]:80;
       return 301 https://$host$request_uri;
   }

   server {
       server_name relay.example.com;
       listen 443 ssl http2;
       listen [::]:443 ssl http2;

       ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;
       ssl_protocols TLSv1.2 TLSv1.3;
       ssl_ciphers HIGH:!aNULL:!MD5;

       location / {
           proxy_pass http://127.0.0.1:8008;
           proxy_http_version 1.1;

           # WebSocket upgrade headers
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "Upgrade";

           # Forwarded client headers
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $remote_addr;
           proxy_set_header X-Forwarded-Proto $scheme;

           # Prevent timeout on idle WebSocket connections
           proxy_read_timeout 1h;
           proxy_send_timeout 1h;
       }
   }
   ```

4. **Enable and reload:**
   ```bash
   sudo ln -s /etc/nginx/sites-available/nostream /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

---

## 9. Verify the Public Relay

Once your DNS and reverse proxy are active, verify your relay from the outside world:

### 1. NIP-11 Relay Information Document
Fetch the NIP-11 JSON description over HTTPS:

```bash
curl -s -H 'Accept: application/nostr+json' https://relay.example.com/ | jq .
```

You should receive a JSON response describing your relay capabilities and supported NIPs.

### 2. Live Health Endpoints
```bash
curl -sf https://relay.example.com/healthz && echo "OK"
curl -s https://relay.example.com/readyz | jq .
```

### 3. Connect a Nostr Client
Open your favorite Nostr client (Coracle, Primal, Amethyst, Snort, or Damus) and add:
```text
wss://relay.example.com
```

You can also test connecting directly using command-line utilities such as [`nak`](https://github.com/fiatjaf/nak):

```bash
# Query the relay for latest metadata events
npx nak req -l 1 wss://relay.example.com
```

---

## 10. Operations and Maintenance

### Viewing Logs
View live logs from all services or specifically the relay container:

```bash
cd /opt/nostream
sudo docker compose logs -f --tail=100 nostream
```

### Updating the Relay
When a new nostream version is released:

1. Update your repository clone:
   ```bash
   cd ~/nostream
   git pull
   ```
2. Refresh the release-managed files. `git pull` updates your clone, but the running stack reads the copies under `/opt/nostream` — `docker-compose.yml` and `postgresql.conf` — and they do not follow the repository on their own. When a release changes either file, re-run bootstrap, which refreshes both and keeps your existing `.env` and `.nostr/settings.yaml`; running it on every update is harmless and saves tracking which files changed:
   ```bash
   cd ~/nostream
   sudo ./deploy/bootstrap.sh /opt/nostream
   ```
   Diff the copies first if you edited either by hand; bootstrap overwrites both.
3. Pull the updated Docker image:
   ```bash
   sudo docker pull ghcr.io/cameri/nostream:latest
   ```
4. Run the automated recreate script:
   ```bash
   sudo ./deploy/recreate-relay.sh /opt/nostream
   ```
5. If the release changed `postgresql.conf` — or you re-applied your own sizing after step 2 overwrote it — restart the database. Step 4 recreates `nostream` and `nostream-migrate` only, and none of the settings in that file (`shared_buffers`, `maintenance_work_mem`, `max_connections`) apply to a running server:
   ```bash
   envval() { sudo sed -n "s/^$1=//p" /opt/nostream/.env | tr -d "\"'"; }
   sudo docker compose -f /opt/nostream/docker-compose.yml restart nostream-db
   sudo docker compose -f /opt/nostream/docker-compose.yml exec -T nostream-db \
     psql -U "$(envval DB_USER)" -d "$(envval DB_NAME)" -c 'SHOW shared_buffers;'
   ```
   If the value does not match the file, the container is still reading a stale copy: check that `docker-compose.yml` mounts `/opt/nostream/postgresql.conf` and not a path inside the image.

This runs database migrations, recreates the container, and verifies readiness.
For zero-downtime rolling deploys with blue/green backends, consult the [`Deploy Runbook & HAProxy Guide`](../docs/DEPLOY-RUNBOOK.md).

### Backups

Take two kinds, because they fail differently:

**A logical database dump** is the one that restores reliably. Copying `/opt/nostream/.nostr/data/` while PostgreSQL is running captures a torn, mid-write state that may not start again; use `pg_dump` instead:

```bash
set -o pipefail   # otherwise the pipeline exits with gzip's status and a failed pg_dump looks fine
# .env is mode 600 and root-owned, so read just the two values we need, stripping any quotes.
envval() { sudo sed -n "s/^$1=//p" /opt/nostream/.env | tr -d "\"'"; }
DB_USER="$(envval DB_USER)"
DB_NAME="$(envval DB_NAME)"
dump="$HOME/nostream-$(date +%F).sql.gz"
# Write beside the final name and rename only once the whole pipeline succeeds: a failed
# pg_dump must not leave a fresh .sql.gz that looks like tonight's backup.
sudo docker compose -f /opt/nostream/docker-compose.yml exec -T nostream-db \
  pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$dump.part" \
  && mv "$dump.part" "$dump" || { rm -f "$dump.part"; false; }
```

The rename only happens on success, so a failure leaves no `$dump` at all. Check the dump opens and is not empty before trusting it — `pg_dump` writing into a pipe can still produce a valid gzip of nothing:

```bash
gzip -t ~/nostream-$(date +%F).sql.gz && [ "$(gunzip -c ~/nostream-$(date +%F).sql.gz | wc -c)" -gt 1000 ] && echo "archive OK"
```

Restore into an empty database:

```bash
# .env is mode 600 and root-owned, so read just the two values we need, stripping any quotes.
envval() { sudo sed -n "s/^$1=//p" /opt/nostream/.env | tr -d "\"'"; }
DB_USER="$(envval DB_USER)"
DB_NAME="$(envval DB_NAME)"
gunzip -c ~/nostream-2026-10-29.sql.gz | sudo docker compose -f /opt/nostream/docker-compose.yml exec -T nostream-db \
  psql -U "$DB_USER" -d "$DB_NAME"
```

**Configuration** can be copied directly — these are plain files:
- `/opt/nostream/.env` (secrets and credentials, mode 600)
- `/opt/nostream/.nostr/settings.yaml` (if you created one)
- `/opt/nostream/docker-compose.yml` (your copy may carry local edits)

A filesystem snapshot of the whole host taken with the database stopped is the only safe way to back up the data directory itself.

Test a restore before you need one.

---

## Next Steps

- **Monetize with Admission Fees:** See [`Accepting Payments`](../README.md#accepting-payments) to enable Lightning / LNURL / Zebedee pay-to-relay features.
- **Onion & I2P Hidden Services:** See [`CLI Reference & Common Workflows`](../CLI.md#common-workflows) to expose your relay anonymously.
- **Admin Console & Operations:** See [`Configuration`](../CONFIGURATION.md) to enable the web-based Operator Console at `/admin`.
