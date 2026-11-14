# Threat model — nostream

## What it is

A Nostr relay. It terminates WebSockets, speaks the NIP-01 client protocol
(`EVENT`, `REQ`, `CLOSE`, `AUTH`), verifies and stores events, and answers
subscription filters. It adds NIP-42 authentication, NIP-50 full-text search, and
an HTTP admin API with its own auth. Events live in one of two stores — LMDB or
Postgres with embedded migrations, chosen by configuration — behind one storage
trait, so a defect in either backend is in scope.

## Where untrusted input enters

1. **Any WebSocket frame from an anonymous client.** JSON arrays whose shape the
   client chooses: verb, count of elements, nesting depth, and size.
2. **The event payload.** Arbitrary `content` bytes, arbitrary `tags`
   (unbounded nesting, repeated keys, long values), `kind`, `created_at`, and a
   claimed `id`/`sig` that must be checked before anything is stored.
3. **The filter payload.** `ids`, `authors`, `kinds`, `since`, `until`, `limit`,
   `#tag` values (including prefix ranges such as `#g`), and `search` terms.
   Every field is attacker-chosen: gigantic arrays, empty strings, wildcard
   prefixes, very long terms, thousands of requests per connection.
4. **Subscription lifetime.** How many subscriptions one connection may hold, how
   long a paginated read continues, and what work a `CLOSE` leaves behind.
5. **The storage keys derived from that input.** A term index, tag indexes, and
   range bounds are built from client text; a key shape that overflows LMDB, or a
   query that cannot be bounded, is reachable without a valid event.
6. **The admin HTTP surface**, authenticated, and the health/metrics endpoints.

## Assets, in priority order

1. **Availability for every other user.** One socket from one anonymous client
   must not degrade the process for the rest: no unbounded allocation, no panic
   that ends the process, no work on the accept loop that a client controls.
2. **Integrity of stored events.** No event may be stored without a valid
   signature over its own id; a replaceable or addressable event may be replaced
   only by a newer event from the same key; and an event may be removed only by a
   signed deletion request from that same key, or by the relay's own expiry and
   retention pass. A deletion and an expiry are not replacements — a check that
   expects the store to put something in their place reports supported relay
   behaviour as a defect.
3. **Isolation between users.** A filter must not return events a client is not
   entitled to under the protocol, writes gated behind NIP-42 must not be accepted
   without it, and admin auth must not be bypassable.
4. **Host resources.** A web-of-trust graph rebuild, a query, or an index write
   may not become unbounded or quadratic because of client input.

## Severity guidance

- **Critical**: signature or event-id verification bypass; any injection that
  changes a query's shape rather than its parameters; admin auth bypass reachable
  from an unauthenticated socket; remote code execution; a write that lets one
  client delete or replace another key's events.
- **High**: unauthenticated denial of service reachable with one connection or a
  few KB — process abort, unbounded memory, connection-table blowup, blocking the
  reactor; serving an event to a filter that must not see it.
- **Medium**: amplification that needs sustained traffic or many connections; a
  panic that ends one connection; a leak limited to timing or counters.
- **Low**: hardening gaps behind an authenticated operator on localhost; panics
  in test-only code; a cap that is merely generous.
- Post-authentication admin findings cap at **high** unless they cross into
  another user's data.

## Out of scope

- **The TypeScript implementation** in `src/`, `test/`, `website/` and the Docker
  files that build it. The scanner builds `crates/` only; findings there are not
  actionable for this line.
- TLS termination, reverse-proxy configuration and container deployment
  (`deploy/`, `nginx/`, `Caddyfile*`).
- Spam, abuse and content-moderation policy — a relay's choice, not a defect.
- Bugs in Postgres or LMDB themselves (report upstream); misuse of either by the
  relay is in scope.
- Client-side rendering of event content, and Nostr ecosystem clients.
- Test fixtures, benches and CI configuration.

## Notes that help triage

- The LMDB index is **derived**, but nothing rebuilds it. Its rows are written in
  the same transaction as the event, so it cannot drift from the events on a
  crash, and rebuilding it means re-importing an export into a fresh store —
  there is no online repair path. The row format carries a version byte, and
  `check_version` **rejects** a row written by another version
  (`unsupported format version N`) rather than converting or rebuilding it, so a
  format change is an operator step, not a self-healing one. A key shape that
  makes a valid event unindexable is a correctness bug, not a vulnerability,
  unless it makes one client's write cost unbounded work.
- Per-connection caps and rate limits exist. A cap that is too high is low
  severity unless the work behind it can be reached without cost.
- A malformed client message that aborts the process is high; one that closes
  only that connection is medium.
