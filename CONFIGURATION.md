# Configuration

# Environment variables

The following environment variables can be set:

| Name             | Description                    | Default           |
|------------------|--------------------------------|-------------------|
| PORT             | Relay's server port            | 8008              |
| DB_HOST          | PostgresSQL Hostname           |                   |
| DB_PORT          | PostgreSQL Port                |                   |
| DB_USER          | PostgreSQL Username            |                   |
| DB_PASSWORD      | PostgreSQL Password            |                   |
| DB_NAME          | PostgreSQL Database name       |                   |
| NOSTR_CONFIG_DIR | Configuration directory        | ~/.nostr/         |

# Settings

Running `nostr-ts-relay` for the first time creates the settings file in `~/.nostr/settings.json`. If the file is not created and an error is thrown ensure that the `~/.nostr` folder exists. The configuration directory can be changed by setting the `NOSTR_CONFIG_DIR` environment variable.

| Name                                        | Description                                                                   |
|---------------------------------------------|-------------------------------------------------------------------------------|
| info.relay_url                              | Public-facing URL of your relay. (e.g. wss://relay.your-domain.com) |
| info.name                                   | Public name of your relay. (e.g. TBG's Public Relay) |
| info.description                            | Public description of your relay. (e.g. Toronto Bitcoin Group Public Relay) |
| info.pubkey                                 | Relay operator's Nostr pubkey in hex format. |
| info.contact                                | Relay operator's contact. (e.g. mailto:operator@relay-your-domain.com) |
| workers.count                               | Number of workers to spin up to handle incoming connections. |
|                                             | Spin workers as many CPUs are available when set to zero. Defaults to zero. |
| limits.event.eventId.minLeadingZeroBits     | Leading zero bits required on every incoming event for proof of work. |
|                                             | Defaults to zero. Disabled when set to zero. |
| limits.event.kind.whitelist                 | List of event kinds to allow. Leave empty to allow any. |
| limits.event.kind.blacklist                 | List of event kinds to reject. Leave empty to allow any. |
| limits.event.pubkey.minLeadingZeroBits      | Leading zero bits required on the public key of incoming events for proof of work. |
|                                             | Defaults to zero. Disabled when set to zero. |
| limits.event.pubkey.whitelist               | List of public keys to allow. Only public keys in this list will be able to post to this relay. |
| limits.event.pubkey.blacklist               | List of public keys to reject. Public keys in this list will not be able to post to this relay. |
| limits.event.createdAt.maxPositiveDelta     | Maximum number of seconds an event's `created_at` can be in the future. Defaults to 900 (15 minutes). Disabled when set to zero. |
| limits.event.createdAt.minNegativeDelta     | Maximum number of secodns an event's `created_at` can be in the past.  Defaults to zero. Disabled when set to zero. |
| limits.event.rateLimits[].kinds             | List of event kinds rate limited. Use `[min, max]` for ranges. Optional. |
| limits.event.rateLimits[].period            | Rate limiting period in milliseconds. |
| limits.event.rateLimits[].rate              | Maximum number of events during period. |
| limits.client.subscription.maxSubscriptions | Maximum number of subscriptions per connected client. Defaults to 10. Disabled when set to zero. |
| limits.client.subscription.maxFilters       | Maximum number of filters per subscription. Defaults to 10. Disabled when set to zero. |
| limits.message.rateLimits[].period          | Rate limit period in milliseconds. |
| limits.message.rateLimits[].rate            | Maximum number of messages during period. |
| limits.message.ipWhitelist                  | List of IPs (IPv4 or IPv6) without rate limit. |
