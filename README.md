# [nostr-ts-relay](https://github.com/Cameri/nostr-ts-relay)

<p align="center">
  <img alt="nostr-ts-relay logo" height="256px" width="256px" src="https://user-images.githubusercontent.com/378886/198158439-86e0345a-adc8-4efe-b0ab-04ff3f74c1b2.jpg" />
</p>

<p align="center">
  <a href="https://github.com/Cameri/nostr-ts-relay/releases">
    <img alt="GitHub release" src="https://img.shields.io/github/v/release/Cameri/nostr-ts-relay">
  </a>
  <a href="https://github.com/Cameri/nostr-ts-relay/issues">
    <img alt="GitHub issues" src="https://img.shields.io/github/issues/Cameri/nostr-ts-relay?style=plastic" />
  </a>
  <a href="https://github.com/Cameri/nostr-ts-relay/stargazers">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/Cameri/nostr-ts-relay" />
  </a>
  <img alt="GitHub top language" src="https://img.shields.io/github/languages/top/Cameri/nostr-ts-relay">
  <a href="https://github.com/Cameri/nostr-ts-relay/network">
    <img alt="GitHub forks" src="https://img.shields.io/github/forks/Cameri/nostr-ts-relay" />
  </a>
  <a href="https://github.com/Cameri/nostr-ts-relay/blob/main/LICENSE">
    <img alt="GitHub license" src="https://img.shields.io/github/license/Cameri/nostr-ts-relay" />
  </a>
  <a href='https://coveralls.io/github/Cameri/nostr-ts-relay?branch=main'>
    <img  alt='Coverage Status' src='https://coveralls.io/repos/github/Cameri/nostr-ts-relay/badge.svg?branch=main' />
  </a>
  <a href='https://sonarcloud.io/project/overview?id=Cameri_nostr-ts-relay'>
    <img alt='Sonarcloud quality gate' src='https://sonarcloud.io/api/project_badges/measure?project=Cameri_nostr-ts-relay&metric=alert_status' />
  </a>
  <a href='https://github.com/Cameri/nostr-ts-relay/actions'>
    <img alt='Build status' src='https://github.com/Cameri/nostr-ts-relay/actions/workflows/checks.yml/badge.svg?branch=main&event=push' />
  </a>
</p>

This is a [nostr](https://github.com/fiatjaf/nostr) relay, written in
Typescript.

This implementation is production-ready. See below for supported features.

The project master repository is available on [GitHub](https://github.com/Cameri/nostr-ts-relay).

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/BWx8DY?referralCode=qVdmfO)

## Features

NIPs with a relay-specific implementation are listed here.

- [x] NIP-01: Basic protocol flow description
- [x] NIP-02: Contact list and petnames
- [x] NIP-04: Encrypted Direct Message
- [x] NIP-09: Event deletion
- [x] NIP-11: Relay information document
- [x] NIP-12: Generic tag queries
- [x] NIP-13: Proof of Work
- [x] NIP-15: End of Stored Events Notice
- [x] NIP-16: Event Treatment
- [x] NIP-20: Command Results
- [x] NIP-22: Event `created_at` Limits
- [x] NIP-26: Delegated Event Signing
- [x] NIP-33: Parameterized Replaceable Events

## Requirements

### Standalone setup
- PostgreSQL 15.0
- Redis
- Node v18
- Typescript

### Docker setups
- Node v18
- Docker v20.10
- Docker compose v2.10

## Quick Start (Docker Compose)

Install Docker following the [official guide](https://docs.docker.com/engine/install/).
You may have to uninstall Docker if you installed it using a different guide.

Clone repository and enter directory:
  ```
  git clone git@github.com:Cameri/nostr-ts-relay.git
  cd nostr-ts-relay
  ```

Start with:
  ```
  npm run docker:compose:start -- --detach
  ```

Stop the server with:
  ```
  npm run docker:compose:stop
  ```

## Quick Start (over Tor)
`Docker` `Tor`

Install Docker following the [official guide](https://docs.docker.com/engine/install/).
You may have to uninstall Docker if you installed it using a different guide.

Clone repository and enter directory:
  ```
  git clone git@github.com:Cameri/nostr-ts-relay.git
  cd nostr-ts-relay
  ```

Start with:
  ```
  npm run tor:docker:compose:start
  ```

Print the Tor hostname:
  ```
  npm run tor:hostname
  ```

Stop the server with:
  ```
  npm run tor:docker:compose:stop
  ```

## Quick Start (Standalone)

Set the following environment variables:

  ```
  DB_HOST=localhost
  DB_PORT=5432
  DB_NAME=nostr_ts_relay
  DB_USER=postgres
  DB_PASSWORD=postgres
  REDIS_HOST=localhost
  REDIS_PORT=6379
  REDIS_USER=default
  REDIS_PASSWORD=nostr_ts_relay
  ```

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
  git clone git@github.com:Cameri/nostr-ts-relay.git
  cd nostr-ts-relay
  ```

Install dependencies:

  ```
  npm install -g knex
  npm install
  ```

Run migrations (at least once and after pulling new changes):

  ```
  npm run db:migrate
  ```

Create ~/.nostr folder:

  ```
  mkdir ~/.nostr
  ```

To start in development mode:

  ```
  npm run dev
  ```

Or, start in production mode:

  ```
  npm run start
  ```

To clean up the build, coverage and test reports run:

  ```
  npm run clean
  ```
## Tests

### Unit tests

Open a terminal and change to the project's directory:
  ```
  cd /path/to/nostr-ts-relay
  ```

Run unit tests with:

  ```
  npm run test:unit
  ```

Or, run unit tests in watch mode:

  ```
  npm run test:unit:watch
  ```

To get unit test coverage run:

  ```
  npm run cover:unit
  ```

To see the unit tests report open `.test-reports/unit/index.html` with a browser:
  ```
  open .test-reports/unit/index.html
  ```

To see the unit tests coverage report open `.coverage/unit/lcov-report/index.html` with a browser:
  ```
  open .coverage/unit/lcov-report/index.html
  ```

### Integration tests (Docker Compose)

Open a terminal and change to the project's directory:
  ```
  cd /path/to/nostr-ts-relay
  ```

Run integration tests with:

  ```
  npm run docker:test:integration
  ```

And to get integration test coverage run:

  ```
  npm run docker:cover:integration
  ```

### Integration tests (Standalone)

Open a terminal and change to the project's directory:
  ```
  cd /path/to/nostr-ts-relay
  ```

Set the following environment variables:

  ```
  DB_HOST=localhost
  DB_PORT=5432
  DB_NAME=nostr_ts_relay_test
  DB_USER=postgres
  DB_PASSWORD=postgres
  DB_MIN_POOL_SIZE=1
  DB_MAX_POOL_SIZE=2
  ```

Then run the integration tests:

  ```
  npm run test:integration
  ```

To see the integration tests report open `.test-reports/integration/report.html` with a browser:
  ```
  open .test-reports/integration/report.html
  ```

To get the integration test coverage run:

  ```
  npm run cover:integration
  ```

To see the integration test coverage report open `.coverage/integration/lcov-report/index.html` with a browser.

  ```
  open .coverage/integration/lcov-report/index.html
  ```

## Configuration

You can change the default folder by setting the `NOSTR_CONFIG_DIR` environment variable to a different path.

Run nostr-ts-relay using one of the quick-start guides at least once and `~/.nostr/settings.json` will be created.
Any changes made to the settings file will be read on the next start.

A sample settings file is included at the project root under the name `settings.sample.json`. Feel free to copy it to `~/.nostr/settings.json`
if you would like to have a settings file before running the relay first.

See [CONFIGURATION.md](CONFIGURATION.md) for a detailed explanation of each environment variable and setting.
## Dev Channel

For development discussions, please use the [Nostr Typescript Relay Dev Channel](https://t.me/nostr_ts_relay).

For discussions about the protocol, please feel free to use the [Nostr Telegram Channel](https://t.me/nostr_protocol).

## License

This project is MIT licensed.
