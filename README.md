# [nostream](https://github.com/Cameri/nostream)

<p align="center">
  <img alt="nostream logo" height="256px" width="256px" src="https://user-images.githubusercontent.com/378886/198158439-86e0345a-adc8-4efe-b0ab-04ff3f74c1b2.jpg" />
</p>

<p align="center">
  <a href="https://github.com/Cameri/nostream/releases">
    <img alt="GitHub release" src="https://img.shields.io/github/v/release/Cameri/nostream">
  </a>
  <a href="https://github.com/Cameri/nostream/issues">
    <img alt="GitHub issues" src="https://img.shields.io/github/issues/Cameri/nostream?style=plastic" />
  </a>
  <a href="https://github.com/Cameri/nostream/stargazers">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/Cameri/nostream" />
  </a>
  <img alt="GitHub top language" src="https://img.shields.io/github/languages/top/Cameri/nostream">
  <a href="https://github.com/Cameri/nostream/network">
    <img alt="GitHub forks" src="https://img.shields.io/github/forks/Cameri/nostream" />
  </a>
  <a href="https://github.com/Cameri/nostream/blob/main/LICENSE">
    <img alt="GitHub license" src="https://img.shields.io/github/license/Cameri/nostream" />
  </a>
  <a href='https://coveralls.io/github/Cameri/nostream?branch=main'>
    <img  alt='Coverage Status' src='https://coveralls.io/repos/github/Cameri/nostream/badge.svg?branch=main' />
  </a>
  <a href='https://sonarcloud.io/project/overview?id=Cameri_nostr-ts-relay'>
    <img alt='Sonarcloud quality gate' src='https://sonarcloud.io/api/project_badges/measure?project=Cameri_nostr&metric=alert_status' />
  </a>
  <a href='https://github.com/Cameri/nostream/actions'>
    <img alt='Build status' src='https://github.com/Cameri/nostream/actions/workflows/checks.yml/badge.svg?branch=main&event=push' />
  </a>
</p>

This is a [nostr](https://github.com/fiatjaf/nostr) relay, written in
Typescript.

This implementation is production-ready. See below for supported features.

The project master repository is available on [GitHub](https://github.com/Cameri/nostream).

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/Xfk5F7?referralCode=Kfv2ly)

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
- [x] NIP-28: Public Chat
- [x] NIP-33: Parameterized Replaceable Events
- [x] NIP-40: Expiration Timestamp
- [x] NIP-111: Relay Information Document Extensions

## Requirements

### Standalone setup
- PostgreSQL 14.0
- Redis
- Node v18
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

- [Set up a Paid Nostr relay with Nostream and ZBD](https://andreneves.xyz/p/how-to-setup-a-paid-nostr-relay) by [André Neves](https://snort.social/p/npub1rvg76s0gz535txd9ypg2dfqv0x7a80ar6e096j3v343xdxyrt4ksmkxrck) (CTO & Co-Founder at [ZEBEDEE](https://zebedee.io/))
- [Set up a Nostr relay in under 5 minutes](https://andreneves.xyz/p/set-up-a-nostr-relay-server-in-under) by [André Neves](https://twitter.com/andreneves) (CTO & Co-Founder at [ZEBEDEE](https://zebedee.io/))

## Local Quick Start (Docker Compose)

Install Docker Desktop following the [official guide](https://docs.docker.com/desktop/).
You may have to uninstall Docker on your machine if you installed it using a different guide.

Clone repository and enter directory:
  ```
  git clone git@github.com:Cameri/nostream.git
  cd nostream
  ```

Start:
  ```
  ./scripts/start_local
  ```

  This will run in the foreground of the terminal until you stop it with Ctrl+C.

## Quick Start (Docker Compose)

Install Docker following the [official guide](https://docs.docker.com/engine/install/).
You may have to uninstall Docker if you installed it using a different guide.

Clone repository and enter directory:
  ```
  git clone git@github.com:Cameri/nostream.git
  cd nostream
  ```

Start:
  ```
  ./scripts/start
  ```
  or
  ```
  ./scripts/start_with_tor
  ```

Stop the server with:
  ```
  ./scripts/stop
  ```

Print the Tor hostname:
  ```
  ./scripts/print_tor_hostname
  ```

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
  ExecStart=/home/nostr/nostream/scripts/start
  ExecStop=/home/nostr/nostream/scripts/stop

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

## Quick Start (Standalone)

Set the following environment variables:

  ```
  DB_URI="postgresql://postgres:postgres@localhost:5432/nostr_ts_relay_test"

  or

  DB_HOST=localhost
  DB_PORT=5432
  DB_NAME=nostr_ts_relay
  DB_USER=postgres
  DB_PASSWORD=postgres

  REDIS_URI="redis://default:nostr_ts_relay@localhost:6379"

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
  git clone git@github.com:Cameri/nostream.git
  cd nostream
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

Create .nostr folder inside nostream project folder:

  ```
  mkdir .nostr
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
  cd /path/to/nostream
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
  cd /path/to/nostream
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

Run nostream using one of the quick-start guides at least once and `nostream/.nostr/settings.json` will be created.
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

## License

This project is MIT licensed.
