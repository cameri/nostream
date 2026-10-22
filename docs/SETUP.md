# Production Relay Setup Guide

> **Verified against:** nostream v3.6.2 (Ubuntu 24.04 LTS, Docker Engine 27+, Docker Compose v2)  
> **Maintenance:** Maintained in-tree and reviewed whenever changes land in `deploy/` or compose configurations.

This is the canonical first-party guide for deploying and operating a production [nostream](https://github.com/cameri/nostream) Nostr relay. It covers host preparation, the automated deployment bootstrap, reverse proxy configuration with automatic TLS, verification, and ongoing maintenance.

---

## What You Need

Before you begin, ensure you have:

1. **A Linux host:** A VPS or dedicated server (Ubuntu 24.04 LTS or Debian 12 recommended) with at least:
   - 2 vCPUs
   - 4 GB RAM
   - 20+ GB SSD disk space (PostgreSQL event store grows over time)
   - A public IPv4 address (and optional IPv6)
2. **A domain name:** A domain or subdomain you control (e.g. `relay.example.com`).
   - Create a DNS `A` record pointing `relay.example.com` to your server's IPv4 address.
   - If using IPv6, create an `AAAA` record pointing to your server's IPv6 address.
3. **Open firewall ports:**
   - Port `80` (HTTP, for ACME certificate issuance and redirect)
   - Port `443` (HTTPS / WSS, for secure client connections)
   - Port `22` (SSH, management)

---

## Common Traps to Avoid

If you have read older community guides, be aware of the following anti-patterns:

- **Do NOT expose port 8008 publicly:** The relay binds to `127.0.0.1:8008` by default. Only your local reverse proxy (Caddy or Nginx) should connect to it. Exposing port 8008 directly bypasses TLS and proxy connection limits.
- **Do NOT copy `migrations/` or `knexfile.js` to the host:** Database migrations are baked inside the container image and run automatically through a one-shot container (`nostream-migrate`) during startup.
- **Do NOT copy a full `settings.yaml` to the host:** The relay automatically loads defaults from `resources/default-settings.yaml` inside the image. You only need to supply the specific keys you wish to override. Creating a full copy prevents you from automatically receiving new settings defaults added in future releases.
- **Do NOT install Docker via Snap:** Snap Docker packages apply sandbox restrictions that can interfere with volume mounts and loopback socket networking. Use Docker's official apt/yum repositories.

---

## 1. Install Docker Engine and Compose

Install Docker Engine and the Compose plugin from the official Docker repository:

```bash
# Remove any conflicting packages
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do
  sudo apt-get remove -y $pkg || true
done

# Add Docker's official GPG key
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository to Apt sources
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
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

---

## 4. Choose Your Relay Image

The production compose stack uses pre-built images from GitHub Container Registry (GHCR):

- `ghcr.io/cameri/nostream:latest` — Tracks the latest official release.
- `ghcr.io/cameri/nostream:vX.Y.Z` — Pins a specific release version (recommended for strict immutability, e.g. `ghcr.io/cameri/nostream:v3.6.2`).

Pull the image onto the server:

```bash
sudo docker pull ghcr.io/cameri/nostream:latest
```

> [!NOTE]
> `docker-compose.yml` sets `pull_policy: never` on relay services so that Docker Compose does not attempt to pull during startup or flapping network conditions. You explicitly pull images when deploying or upgrading.

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

## 6. (Optional) Custom Relay Metadata and Settings

By default, the relay uses internal defaults from the image (`resources/default-settings.yaml`).

If you want to set your relay name, description, contact email, or pubkey, create an overrides file:

```bash
sudo cp ~/nostream/deploy/settings.yaml.example /opt/nostream/.nostr/settings.yaml
sudo chown 1000:1000 /opt/nostream/.nostr/settings.yaml
sudo chmod 600 /opt/nostream/.nostr/settings.yaml
sudo nano /opt/nostream/.nostr/settings.yaml
```

Edit the fields you wish to override:

```yaml
info:
  relay_url: wss://relay.example.com
  name: "My Nostr Relay"
  description: "A community Nostr relay powered by nostream."
  pubkey: "<your-64-character-hex-nostr-pubkey>"
  contact: "mailto:operator@example.com"
```

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

Expected output for `/readyz`:
```json
{"status":"ready","database":{"ok":true},"cache":{"ok":true}}
```

---

## 8. Put the Relay Behind TLS

The relay listens on `127.0.0.1:8008` and requires a reverse proxy to terminate TLS on port 443 and handle WebSocket upgrades.

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
2. Pull the updated Docker image:
   ```bash
   sudo docker pull ghcr.io/cameri/nostream:latest
   ```
3. Run the automated recreate script:
   ```bash
   sudo ./deploy/recreate-relay.sh /opt/nostream
   ```

This runs database migrations, recreates the container, and verifies readiness.  
For zero-downtime rolling deploys with blue/green backends, consult the [`Deploy Runbook & HAProxy Guide`](../docs/DEPLOY-RUNBOOK.md).

### Backups
Back up the following paths regularly:
- `/opt/nostream/.env` (Secrets and credentials)
- `/opt/nostream/.nostr/data/` (PostgreSQL database volume)
- `/opt/nostream/.nostr/settings.yaml` (Optional custom settings)

---

## Next Steps

- **Monetize with Admission Fees:** See [`Accepting Payments`](../README.md#accepting-payments) to enable Lightning / LNURL / Zebedee pay-to-relay features.
- **Onion & I2P Hidden Services:** See [`CLI Reference & Common Workflows`](../CLI.md#common-workflows) to expose your relay anonymously.
- **Admin Console & Operations:** See [`Configuration`](../CONFIGURATION.md) to enable the web-based Operator Console at `/admin`.
