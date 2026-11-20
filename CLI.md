# Nostream CLI

Nostream ships a unified command-line interface, `nostream-cli`, whose program name on every
page and message is `nostream`:

```bash
nostream --help
nostream --version
```

With no arguments it prints the help page on stdout and exits successfully, in a terminal and
out of one alike; the page, `--help` and an unknown command are answered before the argument
parser runs.

## Exit Codes

- `0`: success
- `1`: runtime/validation error
- `2`: usage error (invalid command/options)

An unknown command prints `Unknown command: <word>` on stderr and the help page on stdout, at
exit `2`.

A failure carries the `Error: ` prefix only when the command threw it — the parser's own usage
errors and the commands' thrown validations. A message a command reports itself is printed bare,
with the code it chose:

```bash
nostream invite create --uses 0    # Error: --uses must be a positive integer, exit 2
nostream seed --count 0            # Error: --count must be a positive integer, exit 1
nostream config get payments.x     # Path not found: payments.x, exit 1
```

`--json` failures are the envelope `{"error":{"message":…,"code":N}}` on stderr.

## Core Commands

```bash
nostream start [--tor] [--i2p] [--nginx] [--debug] [--port 8008]
nostream stop [--all|--tor|--i2p|--nginx|--local]
nostream info [--tor-hostname] [--i2p-hostname] [--json]
nostream update
nostream clean
nostream setup [--yes] [--start]
nostream seed [--count 100]
nostream invite create [--uses N] [--expires-in <seconds>] [--json]
nostream import [file.jsonl|file.json] [--file file.jsonl|file.json] [--batch-size 1000]
nostream export [output] [--output output] [--format jsonl|json|gzip|gz|xz] [-z]
nostream clean-db [--all|--older-than=<days>|--kinds=<1,7,4>] [--dry-run] [--force]
```

`--version` and `-v` print `nostream/<version>`.

`info`, `seed`, `invite create`, `export` and `clean-db` read the store the settings name, and
take `--data-dir <DIR>` for the LMDB root: the environment lives at `<DIR>/lmdb`, the layout
`nostream-cli migrate pg-to-lmdb --target <DIR>` writes. With the lmdb backend selected and no
`--data-dir`, the command fails with `Error: the lmdb backend needs --data-dir <path>`.

## Cleaning events

`clean-db` deletes events by age, by kind, or every event. Nothing else is touched: invite
codes, invoices and users survive.

```
nostream clean-db [options]

  --all                  Delete all events.
  --older-than=<days>    Delete events older than the given number of days.
  --kinds=<1,7,4>        Delete events for specific kinds.
  --dry-run              Show how many rows would be deleted without deleting them.
  --force                Skip interactive confirmation prompt.
  --help                 Show this help message.
```

`--all` cannot be combined with `--older-than` or `--kinds`, and at least one of the three is
required. Without `--force` a terminal is asked to type `DELETE`; a piped stdin refuses with
`Interactive confirmation is unavailable. Re-run with --force.` and exit 1. `NODE_ENV=production`
prints a warning on stderr and changes nothing else.

What a run costs: the LMDB delete commits one batch of 10 000 rows at a time so a relay sharing
the store keeps its writer between batches. On a 160 001-row store that is 17 commits and about
1.6× the wall clock of one statement (28 s against 18 s). It also writes more bytes than the
rows it removes, and the two measured ends of that trade bracket the shipped shape: the 1 000-row
batch shape wrote **5.31 GB** where one transaction wrote **1.41 MB**, and it grows the store file
less (**69.8 MB** against **242.9 MB**). The shipped 10 000-row shape's write volume sits between
the two and was not measured; its commit count, which is what charges it, is 17. `--dry-run` counts the same rows with one
read walk (202 ms on that store), so run it first on a big store.

A run that stops after some batches committed says so: the failure's line opens with the rows
already deleted (`4000 events were deleted before the failure: …`, exit 1). The store is then
part-deleted by design, and a re-run removes only what is left.

## NIP-43 invite codes

Join (kind 28934) is already implemented. Operators mint a claim string and share it out of band; the client then publishes a join request with a `claim` tag.

```bash
# Local PostgreSQL (DB_URI or DB_HOST in the environment / .env)
nostream invite create
nostream invite create --uses 3 --expires-in 86400 --json

# Docker: Postgres is not published to the host
docker compose exec nostream node src/cli/index.js invite create
```

`--uses` defaults to `nip43.defaultMaxUses` (1). `--expires-in` defaults to `nip43.inviteCodeExpirySeconds` (600 = 10 minutes). `--expires-in` must be a positive integer; never-expiring codes are a yaml policy (`nip43.inviteCodeExpirySeconds: 0`), not a CLI flag. The printed code is the first line of human output so scripts can capture it. If `info.self` is a hex pubkey or `npub1…`, it is stored as `created_by`.

The relay also answers `REQ`s for kind 28935 by minting a code on the fly and returning it as a relay-signed ephemeral event, so users can obtain a claim string without an operator handing one out. It is off by default and requires `nip43.enabled`, `nip43.allowInviteRequests` and a NIP-42 authenticated client — see [CONFIGURATION.md](CONFIGURATION.md). Membership list events (kind 13534) are not published yet.

Invites minted over `REQ` record the requesting pubkey as `created_by`; `nostream invite create` records `info.self`.

### Relay signing pubkey

NIP-43 clients verify relay-signed events against the `self` field of the NIP-11 document, so `self` must match the key the relay actually signs with. That key is derived from `SECRET` and is otherwise invisible, so `nostream info` prints it:

```bash
nostream info | grep 'Signing pubkey'
nostream info --json     # same value under relay.signingPubkey
```

Leave `info.self` unset in settings to have this value advertised automatically. Set it only if you want to pin it explicitly, and set it to exactly this value — a mismatch disables kind 28935 invite requests.

## Removed Legacy Wrappers

The old shell wrapper scripts are no longer shipped in `scripts/`.
Use the unified `nostream` CLI directly instead:

```bash
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

## Configuration Commands

```bash
nostream config list
nostream config list --json
nostream config get <path>
nostream config get <path> --json
nostream config set <path> <value> [--type inferred|json] [--validate|--no-validate] [--restart]
nostream config validate

nostream config env list [--show-secrets]
nostream config env get <key> [--show-secrets]
nostream config env set <key> <value>
nostream config env validate
```

Path syntax supports dot keys and array indexes:

```bash
nostream config get limits.event.content[0].maxLength
nostream config set limits.event.content[0].maxLength 2048
nostream config set nip05.domainWhitelist '["example.com","relay.io"]' --type json
```

## Development

The TypeScript development loop (`db:reset`, `seed:relay`, `docker:clean`, the `test:*`
wrappers) is not part of this binary: the wrapper died with the TypeScript line (#869). Its one
real operator operation, `db:clean`, is the top-level `clean-db` above. The Rust suite is the
one `cargo test --workspace --all-features` runs.

## TUI Navigation

The interactive settings editor is not ported yet: `nostream tui` is a labelled stub, and the
no-argument path prints the help page rather than launching it. What the capture's TUI offered:

```bash
nostream tui
```

Main menu includes:
- Start relay
- Stop relay
- Configure settings
- Manage data (export/import)
- Development tools
- View relay info
- Exit

TUI behavior highlights:
- Each submenu includes an explicit `Back` option, so you can return without using signal keys.
- Start menu prompts for Tor/I2P/Debug, optional custom port, and final confirmation.
- Configure menu offers guided editing for common categories such as payments, network, and limits.
- Advanced dot-path get/set remains available for full settings access.
- Manage menu asks for import/export format and file paths.
- Dev menu displays explicit destructive warnings before DB reset/clean and Docker clean.

## Common Workflows

```bash
# Start relay with Tor + I2P
nostream start --tor --i2p

# Print Tor hostname
nostream info --tor-hostname

# Machine-readable output for automation
nostream info --json
nostream config list --json
nostream config get payments.enabled --json

# Import and export events
nostream import --file ./events.jsonl --batch-size 500
nostream import --file ./events.json --batch-size 500
nostream export --output backup.jsonl --format jsonl
nostream export --output backup.json --format json

# Update YAML settings and restart relay
nostream config set payments.enabled true --restart

# Update env settings
nostream config env set RELAY_PORT 8008
nostream config env get SECRET --show-secrets
nostream config env validate

# Mint a NIP-43 invite code (kind 28934 join)
nostream invite create --json
docker compose exec nostream node src/cli/index.js invite create
```
