# [nostream](https://github.com/cameri/nostream)

<p align="center">
  <img alt="nostream logo" height="256px" width="256px" src="https://user-images.githubusercontent.com/378886/198158439-86e0345a-adc8-4efe-b0ab-04ff3f74c1b2.jpg" />
</p>

<p align="center">
  <a href="https://github.com/cameri/nostream/releases">
    <img alt="GitHub release" src="https://img.shields.io/github/v/release/Cameri/nostream">
  </a>
  <a href="https://github.com/cameri/nostream/issues">
    <img alt="GitHub issues" src="https://img.shields.io/github/issues/Cameri/nostream?style=plastic" />
  </a>
  <a href="https://github.com/cameri/nostream/stargazers">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/Cameri/nostream" />
  </a>
  <img alt="GitHub top language" src="https://img.shields.io/github/languages/top/Cameri/nostream">
  <a href="https://github.com/cameri/nostream/network">
    <img alt="GitHub forks" src="https://img.shields.io/github/forks/Cameri/nostream" />
  </a>
  <a href="https://github.com/cameri/nostream/blob/main/LICENSE">
    <img alt="GitHub license" src="https://img.shields.io/github/license/Cameri/nostream" />
  </a>
  <a href='https://coveralls.io/github/cameri/nostream?branch=main'>
    <img alt='Coverage Status' src='https://coveralls.io/repos/github/cameri/nostream/badge.svg?branch=main' />
  </a>
  <a href='https://github.com/cameri/nostream/actions'>
    <img alt='Build status' src='https://github.com/cameri/nostream/actions/workflows/checks.yml/badge.svg?branch=main&event=push' />
  </a>
</p>

This is a [nostr](https://github.com/fiatjaf/nostr) relay, written in
Typescript.

This implementation is production-ready. See below for supported features.

The project master repository is available on [GitHub](https://github.com/cameri/nostream).

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/Xfk5F7?referralCode=Kfv2ly)

## Features

NIPs with a relay-specific implementation are listed here.

- [x] NIP-01: Basic protocol flow description
- [x] NIP-02: Contact list and petnames
- [x] NIP-03: OpenTimestamps Attestations for Events
- [x] NIP-04: Encrypted Direct Message
- [x] NIP-05: Mapping Nostr keys to DNS-based internet identifiers
- [x] NIP-09: Event deletion
- [x] NIP-11: Relay information document
- [x] NIP-12: Generic tag queries
- [x] NIP-13: Proof of Work
- [x] NIP-14: Subject tag in text events
- [x] NIP-15: End of Stored Events Notice
- [x] NIP-16: Event Treatment
- [x] NIP-20: Command Results
- [x] NIP-22: Event `created_at` Limits
- [x] NIP-25: Reactions
- [ ] NIP-26: Delegated Event Signing (REMOVED)
- [x] NIP-28: Public Chat
- [x] NIP-33: Parameterized Replaceable Events
- [x] NIP-40: Expiration Timestamp
- [x] NIP-44: Encrypted Payloads (Versioned)
- [x] NIP-45: Event Counts
- [x] NIP-62: Request to Vanish
- [x] NIP-65: Relay List Metadata

## Requirements

### Standalone setup
- PostgreSQL 14.0
- Redis
- Node v24
- Typescript

### Docker setups
- Docker v20.10
- Docker Compose v2.10

### Local Docker setup
- Docker Desktop v4.2.0 or newer
- [mkcert](https://github.com/FiloSottile/mkcert)

WARNING: Docker distributions from Snap, Brew or Debian repositories are NOT SUPPORTED and will result in errors.
Install Docker from their [official guide](https://docs.docker.com/engine/install/) ONLY.

## Full Guide

- [Set up a Paid Nostr relay with Nostream and ZEBEDEE](https://docs.zebedee.io/docs/guides/nostr-relay) by [André Neves](https://primal.net/andre) (CTO & Co-Founder at [ZEBEDEE](https://zebedee.io/))
- [Set up a Nostr relay in under 5 minutes](https://andreneves.xyz/p/set-up-a-nostr-relay-server-in-under) by [André Neves](https://twitter.com/andreneves) (CTO & Co-Founder at [ZEBEDEE](https://zebedee.io/))

### Accepting Payments

1. Before you begin
   - Complete one of the Quick Start guides in this document
   - Create a `.env` file
   - On `.nostr/settings.yaml` file make the following changes:
     - Set `payments.enabled` to `true`
     - Set `payments.feeSchedules.admission.enabled` to `true`
     - Set `limits.event.pubkey.minBalance` to the minimum balance in msats required to accept events (i.e. `1000000` to require a balance of `1000` sats)
   - Choose one of the following payment processors: `zebedee`, `nodeless`, `opennode`, `lnbits`, `lnurl`, `nwc`

2. [ZEBEDEE](https://zebedee.io)
   - Complete the step "Before you begin"
   - [Sign up for a ZEBEDEE Developer Dashboard account](https://dashboard.zebedee.io/signup), create a new LIVE Project, and get that Project's API Key
   - Set `ZEBEDEE_API_KEY` environment variable with the API Key above on your `.env` file

    ```
    ZEBEDEE_API_KEY={YOUR_ZEBEDEE_API_KEY_HERE}
    ```

   - Follow the required steps for all payments processors
   - On `.nostr/settings.yaml` file make the following changes:
     - `payments.processor` to `zebedee`
     - `paymentsProcessors.zebedee.callbackBaseURL` to match your Nostream URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/zebedee`)
   - Restart Nostream (`nostream stop` followed by `nostream start`)
   - Read the in-depth guide for more information: [Set Up a Paid Nostr Relay with ZEBEDEE API](https://docs.zebedee.io/docs/guides/nostr-relay)

3. [Nodeless](https://nodeless.io/?ref=587f477f-ba1c-4bd3-8986-8302c98f6731)
   - Complete the step "Before you begin"
   - [Sign up](https://nodeless.io/?ref=587f477f-ba1c-4bd3-8986-8302c98f6731) for a new account, create a new store and take note of the store ID
   - Go to Profile > API Tokens and generate a new key and take note of it
   - Create a store webhook with your Nodeless callback URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/nodeless`) and make sure to enable all of the events. Grab the generated store webhook secret
   - Set `NODELESS_API_KEY` and `NODELESS_WEBHOOK_SECRET` environment variables with generated API key and webhook secret, respectively

    ```
    NODELESS_API_KEY={YOUR_NODELESS_API_KEY}
    NODELESS_WEBHOOK_SECRET={YOUR_NODELESS_WEBHOOK_SECRET}
    ```

   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `nodeless`
     - Set `paymentsProcessors.nodeless.storeId` to your store ID
   - Restart Nostream (`nostream stop` followed by `nostream start`)

4. [OpenNode](https://www.opennode.com/)
   - Complete the step "Before you begin"
   - Sign up for a new account and get verified
   - Go to Developers > Integrations and setup two-factor authentication
   - Create a new API Key with Invoices permission
   - Set `OPENNODE_API_KEY` environment variable on your `.env` file

     ```
     OPENNODE_API_KEY={YOUR_OPENNODE_API_KEY}
     ```

   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `opennode`
   - Restart Nostream (`nostream stop` followed by `nostream start`)

5. [LNBITS](https://lnbits.com/)
    - Complete the step "Before you begin"
    - Create a new wallet on you public LNbits instance
      - [Demo](https://legend.lnbits.com/) server must not be used for production
      - Your instance must be accessible from the internet and have a valid SSL/TLS certificate
    - Get wallet Invoice/read key (in Api docs section of your wallet)
    - set `LNBITS_API_KEY` environment variable with the Invoice/read key Key above on your `.env` file

      ```
      LNBITS_API_KEY={YOUR_LNBITS_API_KEY_HERE}
      ```
    - On your `.nostr/settings.yaml` file make the following changes:
      - Set `payments.processor` to `lnbits`
      - set `lnbits.baseURL` to your LNbits instance URL (e.g. `https://{YOUR_LNBITS_DOMAIN_HERE}/`)
      - Set `paymentsProcessors.lnbits.callbackBaseURL` to match your Nostream URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/lnbits`)
    - Restart Nostream (`nostream stop` followed by `nostream start`)

6. [Alby](https://getalby.com/) or any LNURL Provider with [LNURL-verify](https://github.com/lnurl/luds/issues/182) support
    - Complete the step "Before you begin"
    - [Create a new account](https://getalby.com/user/new) if you don't have an LNURL
    - On your `.nostr/settings.yaml` file make the following changes:
      - Set `payments.processor` to `lnurl`
      - Set `lnurl.invoiceURL` to your LNURL (e.g. `https://getalby.com/lnurlp/your-username`)
    - Restart Nostream (`nostream stop` followed by `nostream start`)

7. Nostr Wallet Connect (NIP-47 / NWC)
    - Complete the step "Before you begin"
    - Create an app connection in your NWC-compatible wallet and copy the generated NWC URL
    - Set `NWC_URL` environment variable on your `.env` file

      ```
      NWC_URL={NOSTR_WALLET_CONNECT_URL}
      ```

    - On your `.nostr/settings.yaml` file make the following changes:
      - Set `payments.processor` to `nwc`
    - Restart Nostream (`./scripts/stop` followed by `./scripts/start`)

8. Ensure payments are required for your public key
   - Visit https://{YOUR-DOMAIN}/
   - You should be presented with a form requesting an admission fee to be paid
   - Fill out the form and take the necessary steps to pay the invoice
   - Wait until the screen indicates that payment was received
   - Add your relay URL to your favorite Nostr client (wss://{YOUR-DOMAIN}) and wait for it to connect
   - Send a couple notes to test
   - Go to https://websocketking.com/ and connect to your relay (wss://{YOUR_DOMAIN})
   - Convert your npub to hexadecimal using a [Key Converter](https://damus.io/key/)
   - Send the following JSON message: `["REQ", "payment-test", {"authors":["your-pubkey-in-hexadecimal"]}]`
   - You should get back the few notes you sent earlier

## Quick Start (Docker Compose)

For full command reference and interactive mode documentation, see [CLI.md](CLI.md).
Non-interactive CLI usage conventions:
- exit `0` on success
- exit `1` on runtime/validation errors
- exit `2` on usage errors (invalid command/options)

Optional global installation from a source checkout:
  ```
  pnpm add -g .
  nostream --help
  ```

Install Docker following the [official guide](https://docs.docker.com/engine/install/).
You may have to uninstall Docker if you installed it using a different guide.

Clone repository and enter directory:
  ```
  git clone git@github.com:Cameri/nostream.git
  cd nostream
  ```

Generate a secret with: `openssl rand -hex 128`
Copy the output and paste it into an `.env` file:

  ```
  SECRET=aaabbbccc...dddeeefff
  # Secret shortened for brevity
  ```

Start:
  ```
  nostream start
  ```
  or
  ```
  nostream start --tor
  ```
  or
  ```
  nostream start --i2p
  ```
  or
  ```
  RELAY_DOMAIN=relay.example.com CERTBOT_EMAIL=you@example.com nostream start --nginx
  ```

Stop the server with:
  ```
  nostream stop
  ```

Print the Tor hostname:
  ```
  nostream info --tor-hostname
  ```

Print I2P hostname(s):
  ```
  nostream info --i2p-hostname
  ```

The old shell wrapper scripts are no longer shipped in `scripts/`.
Use the unified `nostream` CLI directly instead:

```
scripts/start                -> nostream start
scripts/start_with_tor       -> nostream start --tor
scripts/start_with_i2p       -> nostream start --i2p
scripts/start_with_nginx     -> nostream start --nginx
scripts/stop                 -> nostream stop
scripts/print_tor_hostname   -> nostream info --tor-hostname
scripts/print_i2p_hostname   -> nostream info --i2p-hostname
scripts/update               -> nostream update
scripts/clean                -> nostream clean
```

### Importing events from JSON Lines or JSON Arrays

You can import NIP-01 events from `.jsonl` (JSON Lines) or `.json` (JSON array) files directly into the relay database.

Compressed `.jsonl` files are also supported and decompressed on-the-fly:

- `.jsonl.gz` (Gzip)
- `.jsonl.xz` (XZ)

Basic import:
  ```
  nostream import ./events.jsonl
  ```

Equivalent alias form:
  ```
  nostream import --file ./events.jsonl
  ```

Import from a JSON array file (compatible with `nostream export --format json`):
  ```
  nostream import --file ./events.json
  ```

Import a compressed backup:
  ```
  nostream import ./events.jsonl.gz
  nostream import ./events.jsonl.xz
  ```

Set a custom batch size (default: `1000`):
  ```
  nostream import ./events.jsonl --batch-size 500
  ```

The importer:

- Processes the file line-by-line to keep memory usage bounded.
- Streams JSON array items one by one to keep memory usage bounded.
- Validates NIP-01 schema, event id hash, and Schnorr signature before insertion.
- Inserts in database transactions per batch.
- Skips duplicates without failing the whole import.
- Prints progress in the format:
  `[Processed: 50,000 | Inserted: 45,000 | Skipped: 5,000 | Errors: 0]`

### Running as a Service

By default this server will run continuously until you stop it with Ctrl+C or until the system restarts.

You can [install as a systemd service](https://www.swissrouting.com/nostr.html#installing-as-a-service) if you want the server to run again automatically whenever the system is restarted. For example:

  ```
  $ nano /etc/systemd/system/nostream.service

  # Note: replace "User=..." with your username, and
  # "/home/nostr/nostream" with the directory where you cloned the repo.

  [Unit]
  Description=Nostr TS Relay
  After=network.target
  StartLimitIntervalSec=0

  [Service]
  Type=simple
  Restart=always
  RestartSec=5
  User=nostr
  WorkingDirectory=/home/nostr/nostream
  ExecStart=/usr/bin/env bash -lc 'cd /home/nostr/nostream && nostream start'
  ExecStop=/usr/bin/env bash -lc 'cd /home/nostr/nostream && nostream stop'

  [Install]
  WantedBy=multi-user.target
  ```

And then:

  ```
  systemctl enable nostream
  systemctl start nostream
  ```

The logs can be viewed with:

  ```
  journalctl -u nostream
  ```

## Troubleshooting

### Linux: Docker DNS resolution failures (`EAI_AGAIN`)

On some Linux environments (especially rolling-release distros or setups using
`systemd-resolved`), `docker compose` builds can fail with DNS errors such as:

- `getaddrinfo EAI_AGAIN registry.npmjs.org`
- `Temporary failure in name resolution`

To fix this, configure Docker daemon DNS in `/etc/docker/daemon.json`.

1. Create or update `/etc/docker/daemon.json`:

  ```
  sudo mkdir -p /etc/docker
  sudo nano /etc/docker/daemon.json
  ```

  Add or update the file with:

  ```
  {
    "dns": ["1.1.1.1", "8.8.8.8"]
  }
  ```

  If this file already exists, merge the `dns` key into the existing JSON
  instead of replacing the entire file.

  If your environment does not allow public resolvers, replace `1.1.1.1` and
  `8.8.8.8` with DNS servers approved by your network.

2. Restart Docker:

  ```
  sudo systemctl restart docker
  ```

3. Verify DNS works inside containers:

  ```
  docker run --rm busybox nslookup registry.npmjs.org
  ```

4. Retry starting nostream:

  ```
  nostream start
  ```

Note: avoid `127.0.0.53` in Docker DNS settings because it points to the host's
local resolver stub and is often unreachable from containers.

## Quick Start (Standalone)

Set the following environment variables:

  ```
  DB_URI="postgresql://postgres:postgres@localhost:5432/nostr_ts_relay_test"
  DB_USER=postgres
  ```
  or
  ```
  DB_HOST=localhost
  DB_PORT=5432
  DB_NAME=nostr_ts_relay
  DB_USER=postgres
  DB_PASSWORD=postgres
  ```

  ```
  REDIS_URI="redis://default:nostr_ts_relay@localhost:6379"

  REDIS_HOST=localhost
  REDIS_PORT=6379
  REDIS_USER=default
  REDIS_PASSWORD=nostr_ts_relay
  ```

Generate a long random secret and set SECRET:
You may want to use `openssl rand -hex 128` to generate a secret.

  ```
  SECRET=aaabbbccc...dddeeefff
  # Secret shortened for brevity
  ```

### Initializing the database

Create `nostr_ts_relay` database:

  ```
  $ psql -h $DB_HOST -p $DB_PORT -U $DB_USER -W
  postgres=# create database nostr_ts_relay;
  postgres=# quit
  ```

Start Redis and use `redis-cli` to set the default password and verify:
  ```
  $ redis-cli
  127.0.0.1:6379> CONFIG SET requirepass "nostr_ts_relay"
  OK
  127.0.0.1:6379> AUTH nostr_ts_relay
  Ok
  ```

Clone repository and enter directory:
  ```
  git clone git@github.com:Cameri/nostream.git
  cd nostream
  ```

Install dependencies:

  ```
  corepack enable
  pnpm install
  ```

Run migrations (at least once and after pulling new changes):

  ```
  pnpm db:migrate
  ```

Create .nostr folder inside nostream project folder and copy over the settings file:

  ```
  mkdir .nostr
  cp resources/default-settings.yaml .nostr/settings.yaml
  ```

To start in development mode:

  ```
  pnpm dev
  ```

Or, start in production mode:

  ```
  pnpm start
  ```

To clean up the build, coverage and test reports run:

  ```
  pnpm clean
  ```
## Development & Contributing

For development environment setup, testing, linting, load testing, and contribution guidelines
(including the issue fairness policy, husky pre-commit hooks, and changeset workflow), see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Export Events

Export all stored events to either [JSON Lines](https://jsonlines.org/) (`.jsonl`) or JSON array (`.json`) format. The export streams rows from the database using cursors, so it works safely on relays with millions of events without loading them into memory.

Optional compression is supported for lower storage and transfer costs:

- Gzip via Node's native `zlib`
- XZ via `lzma-native`

```
nostream export                              # writes to events.jsonl
nostream export --output backup-2024-01-01.jsonl # custom filename
nostream export --output backup.jsonl.gz --compress --format=gzip
nostream export --output backup.jsonl.xz --compress --format=xz
nostream export --output backup-2024-01-01.jsonl # alias form
nostream export --output backup-2024-01-01.json --format json # JSON array output
```

Flags:

- `--compress` / `-z`: enable compression.
- `--format <gzip|gz|xz>`: compression format. If omitted while compression is enabled,
  format is inferred from file extension (`.gz` / `.xz`) and defaults to `gzip`.

After completion, the exporter prints a summary with:

- Raw bytes generated from JSONL lines
- Output bytes written to disk
- Compression delta (smaller/larger)
- Throughput in events/sec and bytes/sec

Optional XZ tuning (environment variables):

- `NOSTREAM_XZ_THREADS`: max worker threads for XZ compression.
  Defaults to `4` and is automatically capped to available CPU cores minus one.
- `NOSTREAM_XZ_PRESET`: compression preset from `0` (fastest, larger output)
  to `9` (slowest, smallest output). Default is `6`.

The script reads the same `DB_*` environment variables used by the relay (see [CONFIGURATION.md](CONFIGURATION.md)).

## Benchmark Database Queries

Run the read-only query benchmark to record the planner's choices and timings for the relay's hot-path queries (REQ subscriptions, vanish checks, purge scans, pending-invoice polls):

```
pnpm db:benchmark
pnpm db:benchmark --runs 5 --kind 1 --limit 500
```

The benchmark only issues `EXPLAIN (ANALYZE, BUFFERS)` and `SELECT` statements against your configured database — it never writes. It loads `DB_*` variables from `.env` automatically (via `node --env-file-if-exists=.env`), so no extra setup is required beyond the one you already need to run the relay. Use it to confirm the `events_active_pubkey_kind_created_at_idx`, `events_deleted_at_partial_idx`, and `invoices_pending_created_at_idx` indexes are being picked up.

For a reproducible before/after proof on a throwaway dataset, run:

```
pnpm db:verify-index-impact
```

It seeds ~200k synthetic events, drops the hot-path indexes, runs EXPLAIN (ANALYZE, BUFFERS) for each hot query, recreates the indexes, and prints a BEFORE/AFTER table. See the *Database indexes and benchmarking* section of [CONFIGURATION.md](CONFIGURATION.md).
## Relay Maintenance

Use `nostream dev db:clean` to wipe or prune `events` table data. This also removes
corresponding data from the derived `event_tags` table when present.

Dry run (no deletion):

  ```
  nostream dev db:clean --all --dry-run
  ```

Full wipe:

  ```
  nostream dev db:clean --all --force
  ```

Delete events older than N days:

  ```
  nostream dev db:clean --older-than=30 --force
  ```

Delete only selected kinds:

  ```
  nostream dev db:clean --kinds=1,7,4 --force
  ```

Delete only selected kinds older than N days:

  ```
  nostream dev db:clean --older-than=30 --kinds=1,7,4 --force
  ```

By default, the command asks for explicit confirmation (`Type 'DELETE' to confirm`).
Use `--force` to skip the prompt.


## Configuration

You can change the default folder by setting the `NOSTR_CONFIG_DIR` environment variable to a different path.

Run nostream using one of the quick-start guides at least once and `nostream/.nostr/settings.yaml` will be created.
Any changes made to the settings file will be read on the next start.

Default settings can be found under `resources/default-settings.yaml`. Feel free to copy it to `nostream/.nostr/settings.yaml` if you would like to have a settings file before running the relay first.

See [CONFIGURATION.md](CONFIGURATION.md) for a detailed explanation of each environment variable and setting.

## Dev Channel

For development discussions, please use the [Nostr Typescript Relay Dev Group](https://t.me/nostream_dev).

For discussions about the protocol, please feel free to use the [Nostr Telegram Group](https://t.me/nostr_protocol).

# Author

I'm Cameri on most social networks. You can find me on Nostr by npub1qqqqqqyz0la2jjl752yv8h7wgs3v098mh9nztd4nr6gynaef6uqqt0n47m.

# Contributors (A-Z)

- Anton Livaja
- Juan Angel
- Kevin Smith
- Saransh Sharma
- swissrouting
- André Neves
- Semisol

## License

This project is MIT licensed.
