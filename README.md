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
- [x] NIP-11a: Relay Information Document Extensions
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

- [Set up a Paid Nostr relay with Nostream and ZEBEDEE](https://docs.zebedee.io/docs/guides/nostr-relay) by [André Neves](https://primal.net/andre) (CTO & Co-Founder at [ZEBEDEE](https://zebedee.io/))
- [Set up a Nostr relay in under 5 minutes](https://andreneves.xyz/p/set-up-a-nostr-relay-server-in-under) by [André Neves](https://twitter.com/andreneves) (CTO & Co-Founder at [ZEBEDEE](https://zebedee.io/))

### Accepting Payments

1. Before you begin
   - Complete one of the Quick Start guides in this document
   - Create a `.env` file
   - On `.nostr/settings.yaml` file make the following changes:
     - Set `payments.enabled` to `true`
     - Set `payments.feeSchedules.admission.enabled` to `true`
     - Set `limits.event.pubkey.minBalance` to the minimum balance in msats required to accept events (i.e. `1000000` to require a balance of `1000` sats)
   - Choose one of the following payment processors: `zebedee`, `nodeless`, `opennode`, `lnbits`, `lnurl`

2. [ZEBEDEE](https://zebedee.io)
   - Complete the step "Before you begin"
   - [Sign up for a ZEBEDEE Developer Dashboard account](https://dashboard.zebedee.io/signup), create a new LIVE Project, and get that Project's API Key
   - Set `ZEBEDEE_API_KEY` environment variable with the API Key above on your `.env` file

    ```
    ZEBEDEE_API_KEY={YOUR_ZEBEDEE_API_KEY_HERE}
    ```

   - Follow the required steps for all payments processors
   - On `.nostr/settings.yaml` file make the following changes:
     - `payments.processor` to `zebedee`
     - `paymentsProcessors.zebedee.callbackBaseURL` to match your Nostream URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/zebedee`)
   - Restart Nostream (`./scripts/stop` followed by `./scripts/start`)
   - Read the in-depth guide for more information: [Set Up a Paid Nostr Relay with ZEBEDEE API](https://docs.zebedee.io/docs/guides/nostr-relay)

3. [Nodeless](https://nodeless.io/?ref=587f477f-ba1c-4bd3-8986-8302c98f6731)
   - Complete the step "Before you begin"
   - [Sign up](https://nodeless.io/?ref=587f477f-ba1c-4bd3-8986-8302c98f6731) for a new account, create a new store and take note of the store ID
   - Go to Profile > API Tokens and generate a new key and take note of it
   - Create a store webhook with your Nodeless callback URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/nodeless`) and make sure to enable all of the events. Grab the generated store webhook secret
   - Set `NODELESS_API_KEY` and `NODELESS_WEBHOOK_SECRET` environment variables with generated API key and webhook secret, respectively

    ```
    NODELESS_API_KEY={YOUR_NODELESS_API_KEY}
    NODELESS_WEBHOOK_SECRET={YOUR_NODELESS_WEBHOOK_SECRET}
    ```

   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `nodeless`
     - Set `paymentsProcessors.nodeless.storeId` to your store ID
   - Restart Nostream (`./scripts/stop` followed by `./scripts/start`)

4. [OpenNode](https://www.opennode.com/)
   - Complete the step "Before you begin"
   - Sign up for a new account and get verified
   - Go to Developers > Integrations and setup two-factor authentication
   - Create a new API Key with Invoices permission
   - Set `OPENNODE_API_KEY` environment variable on your `.env` file

     ```
     OPENNODE_API_KEY={YOUR_OPENNODE_API_KEY}
     ```

   - On your `.nostr/settings.yaml` file make the following changes:
     - Set `payments.processor` to `opennode`
   - Restart Nostream (`./scripts/stop` followed by `./scripts/start`)

5. [LNBITS](https://lnbits.com/)
    - Complete the step "Before you begin"
    - Create a new wallet on you public LNbits instance
      - [Demo](https://legend.lnbits.com/) server must not be used for production
      - Your instance must be accessible from the internet and have a valid SSL/TLS certificate
    - Get wallet Invoice/read key (in Api docs section of your wallet)
    - set `LNBITS_API_KEY` environment variable with the Invoice/read key Key above on your `.env` file

      ```
      LNBITS_API_KEY={YOUR_LNBITS_API_KEY_HERE}
      ```
    - On your `.nostr/settings.yaml` file make the following changes:
      - Set `payments.processor` to `lnbits`
      - set `lnbits.baseURL` to your LNbits instance URL (e.g. `https://{YOUR_LNBITS_DOMAIN_HERE}/`)
      - Set `paymentsProcessors.lnbits.callbackBaseURL` to match your Nostream URL (e.g. `https://{YOUR_DOMAIN_HERE}/callbacks/lnbits`)
    - Restart Nostream (`./scripts/stop` followed by `./scripts/start`)

6. [Alby](https://getalby.com/) or any LNURL Provider with [LNURL-verify](https://github.com/lnurl/luds/issues/182) support
    - Complete the step "Before you begin"
    - [Create a new account](https://getalby.com/user/new) if you don't have an LNURL
    - On your `.nostr/settings.yaml` file make the following changes:
      - Set `payments.processor` to `lnurl`
      - Set `lnurl.invoiceURL` to your LNURL (e.g. `https://getalby.com/lnurlp/your-username`)
    - Restart Nostream (`./scripts/stop` followed by `./scripts/start`)

7. Ensure payments are required for your public key
   - Visit https://{YOUR-DOMAIN}/
   - You should be presented with a form requesting an admission fee to be paid
   - Fill out the form and take the necessary steps to pay the invoice
   - Wait until the screen indicates that payment was received
   - Add your relay URL to your favorite Nostr client (wss://{YOUR-DOMAIN}) and wait for it to connect
   - Send a couple notes to test
   - Go to https://websocketking.com/ and connect to your relay (wss://{YOUR_DOMAIN})
   - Convert your npub to hexadecimal using a [Key Converter](https://damus.io/key/)
   - Send the following JSON message: `["REQ", "payment-test", {"authors":["your-pubkey-in-hexadecimal"]}]`
   - You should get back the few notes you sent earlier

## Quick Start (Docker Compose)

Install Docker following the [official guide](https://docs.docker.com/engine/install/).
You may have to uninstall Docker if you installed it using a different guide.

Clone repository and enter directory:
  ```
  git clone git@github.com:Cameri/nostream.git
  cd nostream
  ```

Generate a secret with: `openssl rand -hex 128`
Copy the output and paste it into an `.env` file:

  ```
  SECRET=aaabbbccc...dddeeefff
  # Secret shortened for brevity
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
  DB_USER=postgres
  ```
  or
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

Generate a long random secret and set SECRET:
You may want to use `openssl rand -hex 128` to generate a secret.

  ```
  SECRET=aaabbbccc...dddeeefff
  # Secret shortened for brevity
  ```

### Initializing the database

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
  NODE_OPTIONS="-r dotenv/config" npm run db:migrate
  ```

Create .nostr folder inside nostream project folder and copy over the settings file:

  ```
  mkdir .nostr
  cp resources/default-settings.yaml .nostr/settings.yaml
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
## Development Quick Start (Docker Compose)

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
- Semisol

## License

This project is MIT licensed.
