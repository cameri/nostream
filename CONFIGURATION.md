# Configuration

# Environment variables

The following environment variables can be set:

| Name                             | Description                    | Default                |
|----------------------------------|--------------------------------|------------------------|
| RELAY_PORT                       | Relay's server port            | 8008                   |
| WORKER_COUNT                     | Number of workers override     | No. of available CPUs  |
| DB_HOST                          | PostgresSQL Hostname           |                        |
| DB_PORT                          | PostgreSQL Port                | 5432                   |
| DB_USER                          | PostgreSQL Username            | nostr_ts_relay         |
| DB_PASSWORD                      | PostgreSQL Password              | nostr_ts_relay         |
| DB_NAME                          | PostgreSQL Database name         | nostr_ts_relay         |
| DB_MIN_POOL_SIZE                 | Min. connections per worker      | 16                     |
| DB_MAX_POOL_SIZE                 | Max. connections per worker      | 32                     |
| DB_ACQUIRE_CONNECTION_TIMEOUT    | New connection timeout (ms)      | 60000                  |
| READ_REPLICA_ENABLED             | Read Replica (RR) Toggle         | 'false'                |
| RR_DB_HOST                       | PostgresSQL Hostname (RR)        |                        |
| RR_DB_PORT                       | PostgreSQL Port (RR)             | 5432                   |
| RR_DB_USER                       | PostgreSQL Username (RR)         | nostr_ts_relay         |
| RR_DB_PASSWORD                   | PostgreSQL Password (RR)         | nostr_ts_relay         |
| RR_DB_NAME                       | PostgreSQL Database name (RR)    | nostr_ts_relay         |
| RR_DB_MIN_POOL_SIZE              | Min. connections per worker (RR) | 16                     |
| RR_DB_MAX_POOL_SIZE              | Max. connections per worker (RR) | 32                     |
| RR_DB_ACQUIRE_CONNECTION_TIMEOUT | New connection timeout (ms) (RR) | 60000                  |
| TOR_HOST                         | Tor Hostname                     |                        |
| TOR_CONTROL_PORT                 | Tor control Port                 | 9051                   |
| TOR_PASSWORD                     | Tor control password             | nostr_ts_relay         |
| HIDDEN_SERVICE_PORT              | Tor hidden service port          | 80                     |
| REDIS_HOST                       |                                  |                        |
| REDIS_PORT                       | Redis Port                       | 6379                   |
| REDIS_USER                       | Redis User                       | default                |
| REDIS_PASSWORD                   | Redis Password                   | nostr_ts_relay         |
| NOSTR_CONFIG_DIR                 | Configuration directory          | <project_root>/.nostr/ |
| DEBUG                            | Debugging filter                 |                        |

# Settings

Running `nostream` for the first time creates the settings file in `<project_root>/.nostr/settings.yaml`. If the file is not created and an error is thrown ensure that the `<project_root>/.nostr` folder exists. The configuration directory can be changed by setting the `NOSTR_CONFIG_DIR` environment variable.

| Name                                        | Description                                                                   |
|---------------------------------------------|-------------------------------------------------------------------------------|
| info.relay_url                              | Public-facing URL of your relay. (e.g. wss://relay.your-domain.com) |
| info.name                                   | Public name of your relay. (e.g. TBG's Public Relay) |
| info.description                            | Public description of your relay. (e.g. Toronto Bitcoin Group Public Relay) |
| info.pubkey                                 | Relay operator's Nostr pubkey in hex format. |
| info.contact                                | Relay operator's contact. (e.g. mailto:operator@relay-your-domain.com) |
| network.maxPayloadSize                      | Maximum number of bytes accepted per WebSocket frame |
| network.remoteIpHeader                      | HTTP header from proxy containing IP address from client. |
| mirroring.static[].address                  | Address of mirrored relay. (e.g. ws://100.100.100.100:8008) |
| mirroring.static[].filters                  | Subscription filters used to mirror. |
| mirroring.static[].secret                   | Secret to pass to relays. Nostream relays only. Optional. |
| workers.count                               | Number of workers to spin up to handle incoming connections. |
|                                             | Spin workers as many CPUs are available when set to zero. Defaults to zero. |
| limits.event.eventId.minLeadingZeroBits     | Leading zero bits required on every incoming event for proof of work. |
|                                             | Defaults to zero. Disabled when set to zero. |
| limits.event.kind.whitelist                 | List of event kinds to always allow. Leave empty to allow any. |
| limits.event.kind.blacklist                 | List of event kinds to always reject. Leave empty to allow any. |
| limits.event.pubkey.minLeadingZeroBits      | Leading zero bits required on the public key of incoming events for proof of work. |
|                                             | Defaults to zero. Disabled when set to zero. |
| limits.event.pubkey.whitelist               | List of public keys to always allow. Only public keys in this list will be able to post to this relay. Use for private relays. |
| limits.event.pubkey.blacklist               | List of public keys to always reject. Public keys in this list will not be able to post to this relay. |
| limits.event.createdAt.maxPositiveDelta     | Maximum number of seconds an event's `created_at` can be in the future. Defaults to 900 (15 minutes). Disabled when set to zero. |
| limits.event.createdAt.minNegativeDelta     | Maximum number of secodns an event's `created_at` can be in the past.  Defaults to zero. Disabled when set to zero. |
| limits.event.content[].kinds                | List of event kinds to apply limit. Use `[min, max]` for ranges. Optional. |
| limits.event.content[].maxLength            | Maximum length of `content`. Defaults to 1 MB. Disabled when set to zero. |
| limits.event.rateLimits[].kinds             | List of event kinds rate limited. Use `[min, max]` for ranges. Optional. |
| limits.event.rateLimits[].period            | Rate limiting period in milliseconds. |
| limits.event.rateLimits[].rate              | Maximum number of events during period. |
| limits.event.whitelists.pubkeys             | List of public keys to ignore rate limits. |
| limits.event.whitelists.ipAddresses         | List of IPs (IPv4 or IPv6) to ignore rate limits. |
| limits.client.subscription.maxSubscriptions | Maximum number of subscriptions per connected client. Defaults to 10. Disabled when set to zero. |
| limits.client.subscription.maxFilters       | Maximum number of filters per subscription. Defaults to 10. Disabled when set to zero. |
| limits.message.rateLimits[].period          | Rate limit period in milliseconds. |
| limits.message.rateLimits[].rate            | Maximum number of messages during period. |
| limits.message.ipWhitelist                  | List of IPs (IPv4 or IPv6) to ignore rate limits. |
