# Contributing

When contributing to this repository, please first discuss the change you wish to make via issue,
email, or any other method with the owners of this repository
before making a change.

Please keep the conversations civil, respectful and focus on the topic being discussed.

## Issue Assignment & Fairness Policy

To keep the project moving fairly for everyone, please follow these guidelines:

- **Search before submitting.** Before opening a new issue or PR, search existing issues to avoid
  duplicates or overlapping work.
- **All PRs must have an associated issue.** Open or find a relevant issue before starting work.
  Starting a PR without a linked issue means your work may not be merged, and it does not grant
  automatic assignment of an issue.
- **Avoid snowball PRs.** Keep pull requests focused. Do not mix unrelated fixes, features, or
  changes in a single PR.
- **Prefer older issues first.** When choosing what to work on, prefer resolving older open issues
  before newer ones, unless a blocker exists or the maintainers have explicitly agreed otherwise.
- **Abandoned assignments.** An issue assigned to a contributor and not worked on for **7 days**
  (no comments or commits) is considered abandoned, unless the assignee is actively working on it
  or has requested an extension from a maintainer.
- **Extensions and transfers.** Assignments can be explicitly extended or transferred to another
  contributor if the original assignee is unresponsive.
- **Release your assignment.** If you are no longer interested in an issue, please comment to
  request being unassigned so others can pick it up.

## Development Environment Setup

Install Docker Desktop following the [official guide](https://docs.docker.com/desktop/) (if you
plan to use Docker). You may have to uninstall Docker on your machine if you installed it using a
different guide.

Clone the repository and enter the directory:

```
git clone git@github.com:Cameri/nostream.git
cd nostream
```

Install dependencies (this also sets up Husky pre-commit hooks automatically):

```
corepack enable
pnpm install
```

Use the unified CLI for relay lifecycle and supported development operations from this source
checkout:

```
pnpm run cli -- --help
```

> **Important:** Pre-commit hooks installed by Husky run linting and formatting checks on every
> commit. Do **not** bypass them with `git commit --no-verify`. If a hook fails, fix the reported
> issues before committing.

### Development Quick Start (Docker Compose)

Start the relay (runs in the foreground until stopped with Ctrl+C):

```
pnpm run cli -- start
```

### Development Quick Start (Standalone)

Set the required environment variables (or copy `.env.example` to `.env` and edit it):

```
DB_URI="postgresql://postgres:postgres@localhost:5432/nostr_ts_relay_test"
DB_USER=postgres
```

or:

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

Generate a long random secret and set `SECRET`:

```
SECRET=aaabbbccc...dddeeefff
# Secret shortened for brevity
```

Run migrations (at least once and after pulling new changes):

```
pnpm db:migrate
```

Create the `.nostr` folder and copy the default settings file:

```
mkdir .nostr
cp resources/default-settings.yaml .nostr/settings.yaml
```

Start in development mode:

```
pnpm dev
```

Or start in production mode:

```
pnpm start
```

To clean up build, coverage, and test reports:

```
pnpm clean
```

## Tests

### Linting and formatting (Biome)

Run code quality checks with Biome:

```
pnpm lint
pnpm lint:fix
pnpm format
pnpm check:format
```

### Unit tests

Change to the project's directory:

```
cd /path/to/nostream
```

Run unit tests:

```
pnpm run cli -- dev test:unit
```

Run unit tests in watch mode:

```
pnpm test:unit:watch
```

Get unit test coverage:

```
pnpm cover:unit
```

Open the unit test report:

```
open .test-reports/unit/index.html
```

Open the unit test coverage report:

```
open .coverage/unit/lcov-report/index.html
```

### Integration tests (Docker Compose)

Change to the project's directory:

```
cd /path/to/nostream
```

Run integration tests:

```
pnpm docker:test:integration
```

Get integration test coverage:

```
pnpm docker:cover:integration
```

### Integration tests (Standalone)

Change to the project's directory:

```
cd /path/to/nostream
```

Set the following environment variables:

```
DB_URI="postgresql://postgres:postgres@localhost:5432/nostr_ts_relay_test"

or

DB_HOST=localhost
DB_PORT=5432
DB_NAME=nostr_ts_relay_test
DB_USER=postgres
DB_PASSWORD=postgres
DB_MIN_POOL_SIZE=1
DB_MAX_POOL_SIZE=2
```

Run the integration tests:

```
pnpm run cli -- dev test:integration
```

Open the integration test report:

```
open .test-reports/integration/report.html
```

Get integration test coverage:

```
pnpm cover:integration
```

Open the integration test coverage report:

```
open .coverage/integration/lcov-report/index.html
```

## Security & Load Testing

Nostream includes a specialized security tester to simulate Slowloris-style connection holding and
event flood (spam) attacks. This is used to verify relay resilience and prevent memory leaks.

### Running the Tester

```bash
# Simulates 5,000 idle "zombie" connections + 100 events/sec spam
pnpm test:load --zombies 5000 --spam-rate 100
```

### Analyzing Memory (Heap Snapshots)

To verify that connections are being correctly evicted and memory reclaimed:

1. Ensure the relay is running with `--inspect` enabled (see `docker-compose.yml`).
2. Open **Chrome DevTools** (`chrome://inspect`) and connect to the relay process.
3. In the **Memory** tab, take a **Heap Snapshot** (Baseline).
4. Run the load tester.
5. Wait for the eviction cycle (default: 120s) and take a second **Heap Snapshot**.
6. Switch the view to **Comparison** and select the Baseline snapshot.
7. Verify that object counts (e.g., `WebSocketAdapter`, `SocketAddress`) return to baseline levels.

### Server-Side Monitoring

To observe client and subscription counts in real-time during a test, you can instrument
`src/adapters/web-socket-server-adapter.ts`:

1. Locate the `onHeartbeat()` method.
2. Add the following logging logic:
   ```typescript
   private onHeartbeat() {
     let totalSubs = 0;
     let totalClients = 0;
     this.webSocketServer.clients.forEach((webSocket) => {
       totalClients++;
       const webSocketAdapter = this.webSocketsAdapters.get(webSocket) as IWebSocketAdapter;
       if (webSocketAdapter) {
         webSocketAdapter.emit(WebSocketAdapterEvent.Heartbeat);
         totalSubs += webSocketAdapter.getSubscriptions().size;
       }
     });
     console.log(`[HEARTBEAT] Clients: ${totalClients} | Total subscriptions: ${totalSubs} | Heap Used: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`);
   }
   ```
3. View the live output via Docker logs:
   ```bash
   docker compose logs -f nostream
   ```

## Performance Testing (k6)

Nostream includes k6-based load tests to validate rate limiter behavior under concurrent WebSocket
connections. These tests verify that connection and message rate limits are correctly enforced.

### Prerequisites

Install [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) before running performance
tests. k6 is a standalone Go binary and is not included as an npm dependency.

### Running the Tests

Ensure the relay is running first (`pnpm run cli -- start`), then:

```bash
# Test connection rate limiting
pnpm run cli -- dev test:perf:connection

# Test message rate limiting
pnpm run cli -- dev test:perf:message
```

To test against a different relay instance:

```bash
k6 run -e RELAY_URL=ws://your-host:8008 test/performance/connection-limiting-k6.ts
```

### What the Tests Validate

- **Connection rate limiter** — Ramps concurrent connections through multiple stages and verifies
  the relay rejects excess connections beyond the configured limit (default: 12 conn/sec).
- **Message rate limiter** — Opens WebSocket connections and sends continuous REQ messages,
  verifying the relay returns NOTICE rejections when the message rate limit is exceeded.

## Local Quality Checks

Run dead code and dependency analysis before opening a pull request:

```
pnpm check:deps
```

`pnpm lint` now runs Biome.

## Pull Request Process

1. Update the relevant documentation with details of changes to the interface, this includes new environment
   variables, exposed ports, useful file locations and container parameters.
2. Follow the versioning and changeset process described in [Releases & Versioning](#releases--versioning).
3. You may merge the Pull Request in once you have the sign-off of two other developers, or if you
   do not have permission to do that, you may request the second reviewer to merge it for you.

## Releases & Versioning

This project uses [Changesets](https://github.com/changesets/changesets) for version management.

### For contributors

Every pull request that changes behavior, adds a feature, or fixes a bug **must include a changeset file**. The CI `changeset-check` job will fail if no changeset is present.

To add a changeset:

```bash
pnpm exec changeset
```

This interactive prompt will ask you to:
1. Select the bump type: `major`, `minor`, or `patch`
2. Write a short summary of the change (this becomes the changelog entry)

The command creates a file in `.changeset/` — commit it with your PR.

### Empty changesets (no source code changes)

If your PR **only** updates documentation, CI/CD configuration, or test coverage — and leaves all
production source code untouched — an empty changeset is acceptable:

```bash
pnpm exec changeset --empty
```

Commit the generated `.changeset/*.md` file with your PR. This satisfies CI without producing a
version bump or changelog entry.

This applies to PRs that exclusively contain:

- Documentation updates (README, CONTRIBUTING, CONFIGURATION, etc.)
- CI/CD workflow changes (`.github/` files)
- Test additions or improvements (when no source code is changed)

### Release process

1. Changesets accumulate as PRs are merged to `main`
2. The `Changesets Release` workflow automatically opens a **"chore: release new version 🚀"** PR that aggregates all pending changesets, bumps `package.json`, and updates `CHANGELOG.md`
3. When a maintainer merges the **"chore: release new version 🚀"** PR, the workflow publishes a GitHub release and creates the corresponding git tag
4. The Docker image is then automatically built and pushed to GHCR via the `release.yml` workflow

## Code Quality

Run Biome checks before opening a pull request:

```
pnpm lint
pnpm check:format
```
