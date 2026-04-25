# Nostream CLI

Nostream ships a unified command-line interface:

```bash
nostream --help
pnpm run cli -- --help
```

When run with no arguments in an interactive terminal, `nostream` launches an interactive TUI.
In non-interactive environments, it prints help and exits successfully.

## Exit Codes

- `0`: success
- `1`: runtime/validation error
- `2`: usage error (invalid command/options)

## Core Commands

```bash
nostream start [--tor] [--i2p] [--nginx] [--debug] [--port 8008]
nostream stop [--all|--tor|--i2p|--nginx|--local]
nostream info [--tor-hostname] [--i2p-hostname] [--json]
nostream update
nostream clean
nostream setup [--yes] [--start]
nostream seed [--count 100]
nostream import [file.jsonl|file.json] [--file file.jsonl|file.json] [--batch-size 1000]
nostream export [output] [--output output] [--format jsonl|json]
```

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

## Development Commands

```bash
nostream dev db:clean [--all|--older-than=30|--kinds=1,7,4] [--dry-run] [--force]
nostream dev db:reset [--yes]
nostream dev seed:relay
nostream dev docker:clean [--yes]
nostream dev test:unit
nostream dev test:cli
nostream dev test:integration
```

## TUI Navigation

Run:

```bash
nostream
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
```
