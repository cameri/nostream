# Contributing

Thanks for wanting to help. This guide covers the environment you need, the checks a change has to
pass, and how work actually gets merged — including the common case where your pull request cannot
be opened in this repository directly.

Three things cause most of the friction, so start with them:

- **Open or find an issue first.** Every pull request here has one; a change without a linked issue
  may not be merged, and opening a pull request does not assign the issue to you.
- **Read the setup and test sections below.** A change that has not been run against the tests is
  the reason most first pull requests need a second round.
- **Follow [Pull Requests From Outside Contributors](#pull-requests-from-outside-contributors).**
  If GitHub does not offer you a way to open a pull request here, that section is the path.

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

Set and export the required environment variables (or copy `.env.example` to `.env` and edit it):

```
export DB_URI="postgresql://postgres:postgres@localhost:5432/nostr_ts_relay"
export DATABASE_URI="$DB_URI"
export DB_USER=postgres
```

or:

```
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=nostr_ts_relay
export DB_USER=postgres
export DB_PASSWORD=postgres
```

`DATABASE_URI` is not a duplicate of `DB_URI`: the relay reads `.env` and `DB_URI`, while `pnpm db:migrate` reads `DATABASE_URI` from the exported environment and otherwise falls back to the `DB_*` variables with `nostream` as the database name. Two traps follow: knex does not load `.env`, so a `DATABASE_URI` written there alone never reaches the migration; and migrating with only `DB_URI` set writes the schema into a database the relay never opens. Keep the two in step. The integration suite uses its own `nostr_ts_relay_test` database (see the tests section below).

```
export REDIS_URI="redis://default:nostr_ts_relay@localhost:6379"

export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_USER=default
export REDIS_PASSWORD=nostr_ts_relay
```

Generate a long random secret and set `SECRET`:

```
export SECRET=aaabbbccc...dddeeefff
# Secret shortened for brevity
```

Create the database the relay will use, with the connection values you just set
(`localhost:5432`, user `postgres`, database `nostr_ts_relay`):

```
$ psql -h localhost -p 5432 -U postgres -W
postgres=# create database nostr_ts_relay;
postgres=# quit
```

`.env.example` ships `DB_NAME=nostr_ts_relay` and `DB_USER=nostr_ts_relay`. If you copy that file instead of the block above, the relay connects as the `nostr_ts_relay` role, which the commands here never create: either set `DB_USER=postgres` in `.env`, or create that role and make it the database owner.

The next step sets a server-wide Redis password, so read this first: on a Redis instance another application also uses, either run a dedicated instance for the relay, or leave the password alone, drop the `REDIS_URI` line above and put the existing credentials in `REDIS_*`. `REDIS_URI` takes precedence over the `REDIS_*` variables, so leaving it in place would send the relay to a password that no longer exists.

Set the Redis password the default configuration expects, and verify it:

```
$ redis-cli
127.0.0.1:6379> CONFIG SET requirepass "nostr_ts_relay"
OK
127.0.0.1:6379> AUTH nostr_ts_relay
Ok
127.0.0.1:6379> quit
```

`CONFIG SET` lasts only until Redis restarts. On a dedicated instance, put `requirepass nostr_ts_relay` in the server's configuration file as well, so the password survives a restart.

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

The relay prefers `DB_URI` over `DB_*`, and the CLI starts with `node --env-file-if-exists=.env`, which fills in a variable that is not already set. So a `DB_URI` left in `.env` by the quick start, or exported in this shell, silently points the tests at the development database: they write their fixtures there and delete them again, and the run proves nothing about a clean schema. Use whichever form matches how you configure the relay:

```
export DB_URI="postgresql://postgres:postgres@localhost:5432/nostr_ts_relay_test"

or

export DB_URI=''
export DB_HOST=localhost
export DB_PORT=5432
export DB_NAME=nostr_ts_relay_test
export DB_USER=postgres
export DB_PASSWORD=postgres
export DB_MIN_POOL_SIZE=1
export DB_MAX_POOL_SIZE=2
```

The empty `DB_URI` is deliberate: `--env-file-if-exists` does not overwrite a variable that already exists, so an empty value stops `.env` from supplying the development database, and the client treats it as unset.

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

## Pull Requests From Outside Contributors

Opening a pull request directly against this repository is limited to people GitHub lists as
collaborators, and most people are not. Your work can still be merged — it takes one extra step:

1. Fork the repository on GitHub and create your branch on your own fork.
2. Commit your change there with the changeset described in
   [Releases & Versioning](#releases--versioning), and open a pull request **from your branch to
   your fork's `main`**. That keeps the diff, the CI run and the review discussion in one place.
3. Comment on the issue you are working on with the link to that pull request and a one-line
   summary, and ask for it to be cherry-picked. Mention the commit sha if the branch has more than
   one.

A maintainer copies your commits onto a branch in this repository, opens the pull request here, and
keeps you as the author — the commit is yours and the changelog credits you. Review may ask for
changes; push them to your fork and say so on the issue, and the same branch is picked up again.
You can also cherry-pick your own work across with `git cherry-pick -x <sha>`, which records where
it came from.

Two things make a cherry-pick quick: a branch with a single focused commit, and the changeset
already in it. A branch that mixes an unrelated fix will usually be asked to split first.

## Becoming a Collaborator

Write access to this repository is granted rarely, because a merge, a CI run and a release here are
the maintainer's responsibility rather than a button press. The path there is short:

- **Land something first.** At least one change through the route above. Thoughtful review on an
  issue or on someone else's pull request counts in your favour too.
- **Ask.** A short note on the pull request that was merged for you is enough. There is no form and
  no waiting list.
- **Talk to the core maintainer.** Access is an interview, in the plain sense: a conversation about
  what you want to work on, how you handle review on your own changes, and whether you are around
  to answer for a merge after it lands.

A request that arrives before a merged contribution will be declined — not as a verdict on the
person, but because the conversation needs something concrete to be about. Land the change, then
ask again. Anyone who stops being reachable, or who pushes to another contributor's branch, keeps
read access and loses write access.

## Pull Request Process

1. Update the relevant documentation with details of changes to the interface, this includes new environment
   variables, exposed ports, useful file locations and container parameters.
2. Follow the versioning and changeset process described in [Releases & Versioning](#releases--versioning).
3. Keep the pull request scoped to the issue it closes. An unrelated fix in the same branch is asked
   to be split into its own pull request.
4. A maintainer merges it once review is satisfied and CI is green; you do not need to merge your own
   work. If you cannot open a pull request here at all, start at
   [Pull Requests From Outside Contributors](#pull-requests-from-outside-contributors).

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
