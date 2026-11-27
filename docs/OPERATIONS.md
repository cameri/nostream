# Operations

Running, backing up and maintaining a relay after it is set up.

## Running as a service

To have it start again whenever the system restarts, install it as a systemd service. For example:

```
$ nano /etc/systemd/system/nostream.service

# Note: replace "User=..." with your username, and
# "/home/nostr/nostream" with the directory where you cloned the repo.

[Unit]
Description=nostream
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

## Importing events
You can import NIP-01 events from `.jsonl` (JSON Lines) or `.json` (JSON array) files directly into the relay database.

Under Docker Compose, Postgres is not published to the host, so run the import inside the relay container and give it a path the container can see:

```
docker compose exec nostream node src/cli/index.js import /home/node/.nostr/events.jsonl
```

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
- Refuses a deletion request (kind `5`) whose `e` tags name more than 65,533 distinct event ids: nothing it names is deleted, the request itself is not stored, and it counts under `Errors` with the reason `invalid: a deletion request may name at most 65533 events`. An id repeated in several `e` tags counts once, and `a` tags are not counted, as v3 does not act on them. The ids are deleted with one statement, and 65,533 is as many as PostgreSQL's 65,535 bind parameters leave room for, so this limit refuses no deletion request a v3 relay could have applied, live, from a peer or by an earlier import.
- Writes each flush as two statements: one multi-row insert for regular events, then one upsert for replaceable ones. A kind `5` delete flushes first, so one batch can become several flushes. There is no transaction spanning them, and a statement that fails inserts nothing and counts its own events as skipped, which is why `Skipped` above can include events that were valid on their own. The insert runs first, so a failed upsert leaves that flush's regular events already written.
- A request to vanish has no effect on an import. The importer builds its writer without a user repository (`src/import-events.ts:222`), so the branch that would delete the author's older events and mark them vanished never runs: the request is stored like any other event. Peering sync does pass one, and its imports do apply it.
- Skips duplicates through `ON CONFLICT DO NOTHING`, without failing the import.
- Upserts replaceable events (kinds `0`, `3`, `41`, `10000`–`19999` and `30000`–`39999`) on `(event_pubkey, event_kind, event_deduplication)`, keeping the newer one. Two replaceable events sharing a key within one upsert can make PostgreSQL refuse the statement (`ON CONFLICT DO UPDATE command cannot affect row a second time`), and that upsert's events count as skipped. A batch dense in competing replaceable events is therefore the case to watch, and `--batch-size 1` avoids it at the cost of one round trip per event.
- Prints progress in the format:
  `[Processed: 50,000 | Inserted: 45,000 | Skipped: 5,000 | Errors: 0]`

## Exporting events
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

The script reads the same `DB_*` environment variables used by the relay (see [CONFIGURATION.md](../CONFIGURATION.md)).

## Benchmarking database queries

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

It seeds ~200k synthetic events, drops the hot-path indexes, runs EXPLAIN (ANALYZE, BUFFERS) for each hot query, recreates the indexes, and prints a BEFORE/AFTER table. See the *Database indexes and benchmarking* section of [CONFIGURATION.md](../CONFIGURATION.md).

Point `DB_*` at a scratch database before running it: it inserts event rows and drops the indexes it is measuring, so against a live relay it both pollutes the store and leaves the hot paths unindexed while it runs.

## Relay maintenance

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
