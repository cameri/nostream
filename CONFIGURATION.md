# Configuration

# Environment variables

The following environment variables can be set:

| Name                             | Description                    | Default                |
|----------------------------------|--------------------------------|------------------------|
| SECRET                           | Long random secret.            | changeme               |
| RELAY_PORT                       | Relay's server port            | 8008                   |
| RELAY_PRIVATE_KEY                | Relay's private key in hex     | (auto-generated)       |
| WORKER_COUNT                     | Number of workers override     | No. of available CPUs  |
| DB_URI                           | PostgreSQL URI (overrides DB_HOST, DB_PORT, etc.) | |
| DB_HOST                          | PostgresSQL Hostname           |                        |
| DB_PORT                          | PostgreSQL Port                | 5432                   |
| DB_USER                          | PostgreSQL Username            | nostr_ts_relay         |
| DB_PASSWORD                      | PostgreSQL Password              | nostr_ts_relay         |
| DB_NAME                          | PostgreSQL Database name         | nostr_ts_relay         |
| DB_MIN_POOL_SIZE                 | Min. connections per worker      | 16                     |
| DB_MAX_POOL_SIZE                 | Max. connections per worker      | 32                     |
| DB_ACQUIRE_CONNECTION_TIMEOUT    | New connection timeout (ms)      | 60000                  |
| READ_REPLICA_ENABLED             | Read Replica (RR) Toggle         | 'false'                |
| READ_REPLICAS                    | Number of read replicas (RR0, RR1, ..., RRn) | 2          |
| RR0_DB_HOST                      | PostgresSQL Hostname (RR)        |                        |
| RR0_DB_PORT                      | PostgreSQL Port (RR)             | 5432                   |
| RR0_DB_USER                      | PostgreSQL Username (RR)         | nostr_ts_relay         |
| RR0_DB_PASSWORD                  | PostgreSQL Password (RR)         | nostr_ts_relay         |
| RR0_DB_NAME                      | PostgreSQL Database name (RR)    | nostr_ts_relay         |
| RR0_DB_MIN_POOL_SIZE             | Min. connections per worker (RR) | 16                     |
| RR0_DB_MAX_POOL_SIZE             | Max. connections per worker (RR) | 32                     |
| RR0_DB_ACQUIRE_CONNECTION_TIMEOUT| New connection timeout (ms) (RR) | 60000                  |
| RR1_DB_HOST                      | PostgresSQL Hostname (RR)        |                        |
| RR1_DB_PORT                      | PostgreSQL Port (RR)             | 5432                   |
| RR1_DB_USER                      | PostgreSQL Username (RR)         | nostr_ts_relay         |
| RR1_DB_PASSWORD                  | PostgreSQL Password (RR)         | nostr_ts_relay         |
| RR1_DB_NAME                      | PostgreSQL Database name (RR)    | nostr_ts_relay         |
| RR1_DB_MIN_POOL_SIZE             | Min. connections per worker (RR) | 16                     |
| RR1_DB_MAX_POOL_SIZE             | Max. connections per worker (RR) | 32                     |
| RR1_DB_ACQUIRE_CONNECTION_TIMEOUT| New connection timeout (ms) (RR) | 60000                  |
| RRn_DB_HOST                      | PostgresSQL Hostname (RR)        |                        |
| RRn_DB_PORT                      | PostgreSQL Port (RR)             | 5432                   |
| RRn_DB_USER                      | PostgreSQL Username (RR)         | nostr_ts_relay         |
| RRn_DB_PASSWORD                  | PostgreSQL Password (RR)         | nostr_ts_relay         |
| RRn_DB_NAME                      | PostgreSQL Database name (RR)    | nostr_ts_relay         |
| RRn_DB_MIN_POOL_SIZE             | Min. connections per worker (RR) | 16                     |
| RRn_DB_MAX_POOL_SIZE             | Max. connections per worker (RR) | 32                     |
| RRn_DB_ACQUIRE_CONNECTION_TIMEOUT| New connection timeout (ms) (RR) | 60000                  |
| TOR_HOST                         | Tor Hostname                     |                        |
| TOR_CONTROL_PORT                 | Tor control Port                 | 9051                   |
| TOR_PASSWORD                     | Tor control password             | nostr_ts_relay         |
| HIDDEN_SERVICE_PORT              | Tor hidden service port          | 80                     |
| REDIS_URI                        | Redis URI (overrides REDIS_HOST, REDIS_PORT, etc.) | |
| REDIS_HOST                       |                                  |                        |
| REDIS_PORT                       | Redis Port                       | 6379                   |
| REDIS_USER                       | Redis User                       | default                |
| REDIS_PASSWORD                   | Redis Password                   | nostr_ts_relay         |
| NOSTR_CONFIG_DIR                 | Configuration directory          | <project_root>/.nostr/ |
| DEBUG                            | Debugging filter                 |                        |
| ZEBEDEE_API_KEY                  | Zebedee Project API Key          |                        |

## I2P

I2P support is provided as a sidecar container (i2pd) via `docker-compose.i2p.yml`, mirroring the Tor setup. No application-level environment variables are needed — the i2pd container creates an I2P server tunnel that forwards traffic to nostream's WebSocket port.

Configuration files live in the `i2p/` directory:

| File | Description |
|------|-------------|
| `i2p/tunnels.conf` | Defines the I2P server tunnel pointing at nostream (port 8008). |
| `i2p/i2pd.conf` | Minimal i2pd daemon configuration. |

Tunnel keys are persisted at `.nostr/i2p/data/` so the `.b32.i2p` address survives container restarts.

The i2pd web console (tunnel status, `.b32.i2p` destinations) is published to the host on **`127.0.0.1:7070`** only. Remove the `ports:` mapping in `docker-compose.i2p.yml` to disable host-side access.

- Start with I2P: `nostream start --i2p`

If you've set READ_REPLICAS to 4, you should configure RR0_ through RR3_.

## Database indexes and benchmarking

The schema ships with a small, query-driven set of indexes. The most important ones for relay hot paths are:

| Index                                        | Covers                                                                                                   |
|----------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `events_active_pubkey_kind_created_at_idx`   | `REQ` with `authors`+`kinds` ordered by `created_at DESC, event_id ASC`; `hasActiveRequestToVanish`; by-pubkey deletes. Composite key `(event_pubkey, event_kind, event_created_at DESC, event_id)` so the ORDER BY tie-breaker is satisfied from the index without a sort step. |
| `events_deleted_at_partial_idx`              | Retention purge over soft-deleted rows. Partial on `deleted_at IS NOT NULL`.                             |
| `invoices_pending_created_at_idx`            | `findPendingInvoices` poll (`ORDER BY created_at ASC`). Partial on `status = 'pending'`.                  |
| `event_tags (tag_name, tag_value)`           | NIP-01 generic tag filters (`#e`, `#p`, …) via the normalized `event_tags` table.                         |
| `events_event_created_at_index`              | Time-range scans (`since` / `until`).                                                                    |
| `events_event_kind_index`                    | Kind-only filters and purge kind-whitelist logic.                                                        |

Run the read-only benchmark against your own database to confirm the planner is using the expected indexes and to record baseline latencies:

```sh
npm run db:benchmark
npm run db:benchmark -- --runs 5 --kind 1 --limit 500
```

The `db:benchmark` script loads the local `.env` file automatically (via `node --env-file-if-exists=.env`), using the same `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` variables as the relay. The benchmark issues only `EXPLAIN (ANALYZE, BUFFERS)` and `SELECT` statements — it never writes. Flags: `--runs <n>` (default 3), `--kind <n>` (default 1 / `TEXT_NOTE`; pass `0` for SET_METADATA), `--limit <n>` (default 500), `--horizon-days <n>` (default 7), `--help`.

For a full before/after proof of the index impact (seeds a throwaway dataset, drops and recreates the indexes, and prints a BEFORE/AFTER table), use:

```sh
npm run db:verify-index-impact
```

The hot-path index migration (`20260420_120000_add_hot_path_indexes.js`) uses `CREATE INDEX CONCURRENTLY`, so it can be applied to a running relay without taking `ACCESS EXCLUSIVE` locks on the `events` or `invoices` tables.

# Settings

Running `nostream` for the first time creates the settings file in `<project_root>/.nostr/settings.yaml`. If the file is not created and an error is thrown ensure that the `<project_root>/.nostr` folder exists. The configuration directory can be changed by setting the `NOSTR_CONFIG_DIR` environment variable. `nostream` will pick up any changes to this settings file without needing to restart.

The settings below are listed in alphabetical order by name. Please keep this table sorted when adding new entries.

| Name                                        | Description                                                                   |
|---------------------------------------------|-------------------------------------------------------------------------------|
| info.contact                                | Relay operator's contact. (e.g. mailto:operator@relay-your-domain.com) |
| info.description                            | Public description of your relay. (e.g. Toronto Bitcoin Group Public Relay) |
| info.name                                   | Public name of your relay. (e.g. TBG's Public Relay) |
| info.pubkey                                 | Relay operator's Nostr pubkey in hex format. |
| info.relay_url                              | Public-facing URL of your relay. (e.g. wss://relay.your-domain.com) |
| limits.admissionCheck.ipWhitelist           | List of IPs (IPv4 or IPv6) to ignore rate limits. |
| limits.admissionCheck.rateLimits[].period   | Rate limit period in milliseconds. |
| limits.admissionCheck.rateLimits[].rate     | Maximum number of admission checks during period. |
| limits.client.subscription.maxFilters       | Maximum number of filters per subscription. Defaults to 10. Disabled when set to zero. |
| limits.client.subscription.maxSubscriptions | Maximum number of subscriptions per connected client. Defaults to 10. Disabled when set to zero. |
| limits.event.content[].kinds                | List of event kinds to apply limit. Use `[min, max]` for ranges. Optional. |
| limits.event.content[].maxLength            | Maximum length of `content`. Defaults to 1 MB. Disabled when set to zero. |
| limits.event.createdAt.maxPositiveDelta     | Maximum number of seconds an event's `created_at` can be in the future. Defaults to 900 (15 minutes). Disabled when set to zero. |
| limits.event.createdAt.minNegativeDelta     | Maximum number of secodns an event's `created_at` can be in the past.  Defaults to zero. Disabled when set to zero. |
| limits.event.eventId.minLeadingZeroBits     | Leading zero bits required on every incoming event for proof of work. |
|                                             | Defaults to zero. Disabled when set to zero. |
| limits.event.kind.blacklist                 | List of event kinds to always reject. Leave empty to allow any. |
| limits.event.kind.whitelist                 | List of event kinds to always allow. Leave empty to allow any. |
| limits.event.pubkey.blacklist               | List of public keys to always reject. Public keys in this list will not be able to post to this relay. |
| limits.event.pubkey.minLeadingZeroBits      | Leading zero bits required on the public key of incoming events for proof of work. |
|                                             | Defaults to zero. Disabled when set to zero. |
| limits.event.pubkey.whitelist               | List of public keys to always allow. Only public keys in this list will be able to post to this relay. Use for private relays. |
| limits.event.rateLimits[].kinds             | List of event kinds rate limited. Use `[min, max]` for ranges. Optional. |
| limits.event.rateLimits[].period | Rate limiting period in milliseconds. For `sliding_window`: the time window during which requests are counted. For `ewma`: the half-life of the exponential decay — shorter values forget bursts faster, longer values are stricter on bursty clients. |
| limits.event.rateLimits[].rate              | Maximum number of events during period. |
| limits.event.retention.kind.whitelist       | Event kinds excluded from retention purge. NIP-62 `REQUEST_TO_VANISH` is always excluded from retention purge, even if not listed here. |
| limits.event.retention.maxDays              | Maximum number of days to retain events. Purge deletes events that are expired (`expires_at`), soft-deleted (`deleted_at`), or older than this window (`created_at`). Any non-positive value disables retention purge. |
| limits.event.retention.pubkey.whitelist     | Public keys excluded from retention purge. |
| limits.event.whitelists.ipAddresses         | List of IPs (IPv4 or IPv6) to ignore rate limits. |
| limits.event.whitelists.pubkeys             | List of public keys to ignore rate limits. |
| limits.message.ipWhitelist                  | List of IPs (IPv4 or IPv6) to ignore rate limits. |
| limits.message.rateLimits[].period          | Rate limit period in milliseconds. |
| limits.client.subscription.maxSubscriptions | Maximum number of subscriptions per connected client. Defaults to 10. Disabled when set to zero. |
| limits.client.subscription.maxFilters       | Maximum number of filters per subscription. Defaults to 10. Disabled when set to zero. |
| limits.message.rateLimits[].period | Rate limiting period in milliseconds. For `sliding_window`: the time window. For `ewma`: the half-life of the decay function. |
| limits.message.rateLimits[].rate            | Maximum number of messages during period. |
| mirroring.static[].address                  | Address of mirrored relay. (e.g. ws://100.100.100.100:8008) |
| mirroring.static[].filters                  | Subscription filters used to mirror. |
| mirroring.static[].limits.event             | Event limit overrides for this mirror. See configurations under limits.event. |
| mirroring.static[].secret                   | Secret to pass to relays. Nostream relays only. Optional. |
| mirroring.static[].skipAdmissionCheck       | Disable the admission fee check for events coming from this mirror. |
| network.maxPayloadSize                      | Maximum number of bytes accepted per WebSocket frame |
| network.remoteIpHeader                      | HTTP header from proxy containing IP address from client. |
| nip05.domainBlacklist                       | List of domains blocked from NIP-05 verification. Authors with NIP-05 at these domains will be rejected. |
| nip05.domainWhitelist                       | List of domains allowed for NIP-05 verification. If set, only authors verified at these domains can publish. |
| nip05.maxConsecutiveFailures                | Number of consecutive verification failures before giving up on an author. Defaults to 20. |
| nip05.mode                                  | NIP-05 verification mode: `enabled` requires verification, `passive` verifies without blocking, `disabled` does nothing. Defaults to `disabled`. |
| nip05.verifyExpiration                      | Time in milliseconds before a successful NIP-05 verification expires and needs re-checking. Defaults to 604800000 (1 week). |
| nip05.verifyUpdateFrequency                 | Minimum interval in milliseconds between re-verification attempts for a given author. Defaults to 86400000 (24 hours). |
| paymentProcessors.lnbits.baseURL            | Base URL of your Lnbits instance. |
| paymentProcessors.lnbits.callbackBaseURL    | Public-facing Nostream's Lnbits Callback URL. (e.g. https://relay.your-domain.com/callbacks/lnbits) |
| paymentProcessors.lnurl.invoiceURL          | [LUD-06 Pay Request](https://github.com/lnurl/luds/blob/luds/06.md) provider URL. (e.g. https://getalby.com/lnurlp/your-username) |
| paymentProcessors.zebedee.baseURL           | Zebedee's API base URL. |
| paymentProcessors.zebedee.callbackBaseURL   | Public-facing Nostream's Zebedee Callback URL (e.g. https://relay.your-domain.com/callbacks/zebedee) |
| paymentProcessors.zebedee.ipWhitelist       | List with Zebedee's API Production IPs. See [ZBD API Documentation](https://api-reference.zebedee.io/#c7e18276-6935-4cca-89ae-ad949efe9a6a) for more info. |
| payments.enabled                            | Enabled payments. Defaults to false. |
| payments.feeSchedules.admission[].amount    | Admission fee amount in msats. |
| payments.feeSchedules.admission[].enabled   | Enables admission fee. Defaults to false. |
| payments.feeSchedules.admission[].whitelists.event_kinds | List of event kinds to waive admission fee. Use `[min, max]` for ranges. |
| payments.feeSchedules.admission[].whitelists.pubkeys | List of pubkeys to waive admission fee. |
| payments.processor                          | Either `zebedee`, `lnbits`, `lnurl`. |
| workers.count                               | Number of workers to spin up to handle incoming connections. |
|                                             | Spin workers as many CPUs are available when set to zero. Defaults to zero. |
| limits.message.ipWhitelist                  | List of IPs (IPv4 or IPv6) to ignore rate limits. |
| limits.admissionCheck.rateLimits[].period | Rate limiting period in milliseconds. For `sliding_window`: the time window. For `ewma`: the half-life of the decay function. |
| limits.admissionCheck.rateLimits[].rate            | Maximum number of admission checks during period. |
| limits.admissionCheck.ipWhitelist                  | List of IPs (IPv4 or IPv6) to ignore rate limits. |
| limits.rateLimiter.strategy | Rate limiting strategy. Either `ewma` or `sliding_window`. Defaults to `ewma`. When using `ewma`, the `period` field in each rate limit serves as the half-life for the exponential decay function. Note: when switching from `sliding_window` to `ewma`, consider increasing `rate` values slightly as EWMA penalizes bursty behavior more aggressively. |
