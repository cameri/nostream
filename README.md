# [nostr-ts-relay](https://github.com/Cameri/nostr-ts-relay)

This is a [nostr](https://github.com/fiatjaf/nostr) relay, written in
Typescript.

The project master repository is available on [GitHub](https://github.com/Cameri/nostr-ts-relay).

## Features

NIPs with a relay-specific implementation are listed here.

- [x] NIP-01: Basic protocol flow description
- [x] NIP-02: Contact list and petnames
- [ ] NIP-03: OpenTimestams Attestations for Events
- [x] NIP-04: Encrypted Direct Message
- [x] NIP-09: Event deletion
- [x] NIP-11: Relay information document
- [x] NIP-12: Generic tag queries
- [ ] NIP-13: Proof of Work
- [x] NIP-15: End of Stored Events Notice
- [x] NIP-16: Event Treatment
- [ ] NIP-25: Reactions
- [x] NIP-27: Multicasting (Experimental)

## Requirements

- PostgreSQL
- Node
- Typescript

## Quick Start

Set the following environment variables:

  ```
  DB_HOST=localhost
  DB_PORT=5432
  DB_NAME=nostr-ts-relay
  DB_USER=postgres
  DB_PASSWORD=postgres
  ```

Create `nostr-ts-relay` database:

  ```
  $ psql -h $DB_HOST -p $DB_PORT -U $DB_USER -W
  postgres=# create database nostr-ts-relay;
  postgres=# quit
  ```

Install dependencies:

  ```
  npm install
  ```

Run migrations:

  ```
  npm run db:migrate
  ```

To start in development mode:

  ```
  npm run dev
  ```

## Configuration

TBD

## Dev Channel

For development discussions, please feel free to use the [Nostr Telegram Channel](https://t.me/nostr_protocol).

## License

This project is MIT licensed.
