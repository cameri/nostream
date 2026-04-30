# nostream

## 3.0.0

### Major Changes

- [#524](https://github.com/cameri/nostream/pull/524) [`b3effd1`](https://github.com/cameri/nostream/commit/b3effd1c4d55ad8e8ebc25d6a13eeef17bb5e6ba) Thanks [@vikashsiwach](https://github.com/vikashsiwach)! - Use exact pubkey matching for fee-schedule whitelists and event pubkey whitelist/blacklist checks.

- [#574](https://github.com/cameri/nostream/pull/574) [`f1c1118`](https://github.com/cameri/nostream/commit/f1c1118ae9a2a032475239f1529db4f24c13d4af) Thanks [@Mahmoud-s-Khedr](https://github.com/Mahmoud-s-Khedr)! - Add a brand-new unified `nostream` CLI/TUI that replaces the legacy `scripts/*` shell wrappers for lifecycle, setup, info, config, data, and development workflows.

  **Fixes** - fixed some consistnacy issues after the migration from `npm` to `pnpm`

### Minor Changes

- [#522](https://github.com/cameri/nostream/pull/522) [`7edd6c3`](https://github.com/cameri/nostream/commit/7edd6c33aa895e672acf653c5b2a980c2c1e0402) Thanks [@a-khushal](https://github.com/a-khushal)! - added NIP-45 COUNT support with end-to-end handling (validation, handler routing, DB counting, and tests).

- [#534](https://github.com/cameri/nostream/pull/534) [`a07b0f6`](https://github.com/cameri/nostream/commit/a07b0f68c7bd18501067ca3e650684488327f4e1) Thanks [@archief2910](https://github.com/archief2910)! - Add hot-path PostgreSQL indexes for subscription, vanish, retention, and invoice queries; add `db:benchmark` and `db:verify-index-impact` tooling; document index rationale and benchmarking. Closes [#68](https://github.com/cameri/nostream/issues/68).

- [#476](https://github.com/cameri/nostream/pull/476) [`49322a9`](https://github.com/cameri/nostream/commit/49322a9449f59569e054166b1a336321d9218960) Thanks [@saniddhyaDubey](https://github.com/saniddhyaDubey)! - Add EWMA rate limiter with configurable strategy support

- [#515](https://github.com/cameri/nostream/pull/515) [`5c12f36`](https://github.com/cameri/nostream/commit/5c12f361f44f5cd59982a502f04d8ca10a45f2cd) Thanks [@archief2910](https://github.com/archief2910)! - Add NIP-03 OpenTimestamps support for kind 1040 events: structural `.ots` validation, Bitcoin attestation requirement, digest match to the referenced `e` tag, and relay metadata updates ([#105](https://github.com/cameri/nostream/issues/105)).

- [#585](https://github.com/cameri/nostream/pull/585) [`ce59383`](https://github.com/cameri/nostream/commit/ce59383fd40e1aed27f26292bf91c34470118e96) Thanks [@CKodidela](https://github.com/CKodidela)! - Add NIP-65 Relay List Metadata support for kind 10002 events: relay list utility with `isRelayListEvent` and `parseRelayList` helpers, unit tests, and relay information document updated to advertise NIP-65 ([#577](https://github.com/cameri/nostream/issues/577)).

- [#514](https://github.com/cameri/nostream/pull/514) [`214bef5`](https://github.com/cameri/nostream/commit/214bef5926b8bacbc7833fa4b31951d177c1d768) Thanks [@Anshumancanrock](https://github.com/Anshumancanrock)! - Add gzip and xz compression support to event import/export flows.

  - Export supports `--compress`/`-z` with `--format gzip|gz|xz`.
  - Import auto-detects compressed input by extension and magic bytes and decompresses in a stream pipeline.
  - Includes docs updates and unit/integration test coverage for compression paths.

- [#539](https://github.com/cameri/nostream/pull/539) [`bdd4f6b`](https://github.com/cameri/nostream/commit/bdd4f6bd402d7962f18f480743cd0b4accb4072e) Thanks [@Justxd22](https://github.com/Justxd22)! - Add NWC (NIP-47) as a payments processor for admission invoices, including configurable invoice expiry and reply timeout handling, compatibility for legacy NWC URI schemes, and docs/env updates.

- [#497](https://github.com/cameri/nostream/pull/497) [`e1a7bfb`](https://github.com/cameri/nostream/commit/e1a7bfb16cd8a1a1625664b649fd3e43b3635808) Thanks [@phoenix-server](https://github.com/phoenix-server)! - Release highlights:

  **Features**

  - NIP-05 verification support ([#463](https://github.com/cameri/nostream/issues/463))
  - NIP-17 & NIP-44 v2 Modern Direct Messages ([#458](https://github.com/cameri/nostream/issues/458))
  - NIP-62 vanish event support ([#418](https://github.com/cameri/nostream/issues/418))
  - Vanish optimization ([#446](https://github.com/cameri/nostream/issues/446))
  - Export events to JSON Lines format ([#451](https://github.com/cameri/nostream/issues/451))
  - Import .jsonl events into events table ([#414](https://github.com/cameri/nostream/issues/414))
  - Opt-in event retention purge ([#359](https://github.com/cameri/nostream/issues/359), [#412](https://github.com/cameri/nostream/issues/412))
  - Wipe events table script ([#450](https://github.com/cameri/nostream/issues/450))
  - Nginx reverse proxy in docker-compose ([#423](https://github.com/cameri/nostream/issues/423))
  - Docker DNS pre-flight check for connectivity verification ([#398](https://github.com/cameri/nostream/issues/398))
  - Strict validation for payment callbacks ([#426](https://github.com/cameri/nostream/issues/426))
  - Real home page with templated pages ([#409](https://github.com/cameri/nostream/issues/409))

  **Bug Fixes**

  - NIP-01 compliance: deterministic event ordering by event_id
  - NIP-01 compliance: correct dedup keys for parametrized replaceable events ([#480](https://github.com/cameri/nostream/issues/480))
  - NIP-01 replaceable event tiebreaker ([#416](https://github.com/cameri/nostream/issues/416))
  - NIP-11 served only on root path instead of relay path ([#399](https://github.com/cameri/nostream/issues/399))
  - Dockerfile: run database migrations in CMD ([#422](https://github.com/cameri/nostream/issues/422))
  - Added expired_at filter to message pipeline ([#403](https://github.com/cameri/nostream/issues/403))
  - Removed unsafe-inline and implemented script nonces for CSP hardening ([#394](https://github.com/cameri/nostream/issues/394))
  - Axios upgraded to fix CVE-2025-62718 ([#466](https://github.com/cameri/nostream/issues/466))

  **Refactors & Chores**

  - Migrated validation from Joi to Zod ([#484](https://github.com/cameri/nostream/issues/484))
  - Migrated linting and formatting to Biome ([#452](https://github.com/cameri/nostream/issues/452))
  - Converted user admission to PostgreSQL stored function ([#428](https://github.com/cameri/nostream/issues/428))
  - Upgraded to Node.js 24 LTS ([#419](https://github.com/cameri/nostream/issues/419))
  - Updated dependencies (express, body-parser, js-yaml, axios)

### Patch Changes

- [#555](https://github.com/cameri/nostream/pull/555) [`ddc811d`](https://github.com/cameri/nostream/commit/ddc811d6eec6f662504c4b5d8f8da3bf2f5c6e9e) Thanks [@Anshumancanrock](https://github.com/Anshumancanrock)! - Migrate project tooling from npm to pnpm across CI workflows, Docker setup, hooks, and contributor commands.

- [#572](https://github.com/cameri/nostream/pull/572) [`b718036`](https://github.com/cameri/nostream/commit/b71803634c71e07861f2af8234e596bafd8f5ff0) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump dev dependency uuid from 8.3.2 to 14.0.0

- [#438](https://github.com/cameri/nostream/pull/438) [`f5ba023`](https://github.com/cameri/nostream/commit/f5ba023871859fc4d72da30299e7f00dd72e2295) Thanks [@tharu-jwd](https://github.com/tharu-jwd)! - fix: close dead connections even if they have active subscriptions

- [#546](https://github.com/cameri/nostream/pull/546) [`faa7ed2`](https://github.com/cameri/nostream/commit/faa7ed2ed652fd768c212a0049b95a29f97632d0) Thanks [@Justxd22](https://github.com/Justxd22)! - Fix root HTML negotiation and subpath-aware template links behind trusted proxies.

- [#575](https://github.com/cameri/nostream/pull/575) [`b7324a6`](https://github.com/cameri/nostream/commit/b7324a616530462f1724377baef51c9e32cbc20c) Thanks [@kanishka0411](https://github.com/kanishka0411)! - Expire stale pending invoices when LNbits no longer has the invoice or reports it as unpaid past its expiry time.

- [#553](https://github.com/cameri/nostream/pull/553) [`3c78e61`](https://github.com/cameri/nostream/commit/3c78e6130b1745142b6443f5576ee5e76d61adc9) Thanks [@Anshumancanrock](https://github.com/Anshumancanrock)! - Fix replaceable batch upserts to apply NIP-01 tie-breaker semantics when timestamps are equal by comparing event IDs.

- [#583](https://github.com/cameri/nostream/pull/583) [`321a9cc`](https://github.com/cameri/nostream/commit/321a9cc8b253ee70f729ddd71af6a94f9acc692f) Thanks [@kanishka0411](https://github.com/kanishka0411)! - Allow generic tag filters to match empty string tag values.

- [#584](https://github.com/cameri/nostream/pull/584) [`a6d32b1`](https://github.com/cameri/nostream/commit/a6d32b19b5064a811bb8e4eb3e354829d8774dcc) Thanks [@Anshumancanrock](https://github.com/Anshumancanrock)! - Use timingSafeEqual for Nodeless webhook HMAC verification and guard against missing NODELESS_WEBHOOK_SECRET

- [#551](https://github.com/cameri/nostream/pull/551) [`7fc0552`](https://github.com/cameri/nostream/commit/7fc055233e0919c4fed24b489fdc189cb139f208) Thanks [@CKodidela](https://github.com/CKodidela)! - Add unit tests for InvoiceRepository and UserRepository with sinon-stubbed DB client

- [#538](https://github.com/cameri/nostream/pull/538) [`9496685`](https://github.com/cameri/nostream/commit/949668540a5e2d4754f9e9f5d5c2ab76833f6191) Thanks [@saniddhyaDubey](https://github.com/saniddhyaDubey)! - Fix: Restore CONFIGURATION.md with proper settings and remove duplicate changesets created during recovery

- [#557](https://github.com/cameri/nostream/pull/557) [`32a1ec5`](https://github.com/cameri/nostream/commit/32a1ec5b6a64c082a171d1c787c3c551810a71ca) Thanks [@a-khushal](https://github.com/a-khushal)! - update NIP-11 relay info fields and CORS, with test and docs updates

- [#511](https://github.com/cameri/nostream/pull/511) [`a38d402`](https://github.com/cameri/nostream/commit/a38d402ba98c3261ae48245ae07e7131398848b1) Thanks [@Priyanshubhartistm](https://github.com/Priyanshubhartistm)! - Migrate runtime logging to pino across adapters, services, workers, and controllers, and stabilize CI-related fixes for coverage and integration workflows after rebasing.

- [#552](https://github.com/cameri/nostream/pull/552) [`25f9637`](https://github.com/cameri/nostream/commit/25f9637237b9b0c8f857b3733bbb091167e455ca) Thanks [@vikashsiwach](https://github.com/vikashsiwach)! - Add integration tests for NIP-02 contact lists (Kind 3)

- [#527](https://github.com/cameri/nostream/pull/527) [`4d030c7`](https://github.com/cameri/nostream/commit/4d030c7dde29903d555e353d5822cb5413ffd2dd) Thanks [@kanishka0411](https://github.com/kanishka0411)! - Add NIP-11 integration tests and fix max_filters mapping in relay information document.

- [#547](https://github.com/cameri/nostream/pull/547) [`664168a`](https://github.com/cameri/nostream/commit/664168ab7128616d4fbf3c8ded69b6bf8aa8d879) Thanks [@Priyanshubhartistm](https://github.com/Priyanshubhartistm)! - Improve NIP-22 `created_at` limit handling coverage and boundary reliability.

  This adds integration coverage for accepted and rejected events across configured positive and negative `created_at` deltas, and keeps rejection semantics consistent (`rejected`) for out-of-range timestamps.

- [#537](https://github.com/cameri/nostream/pull/537) [`a89a95e`](https://github.com/cameri/nostream/commit/a89a95e474e871b2f778306321e7e111e4c16a23) Thanks [@vikashsiwach](https://github.com/vikashsiwach)! - Add NIP-62 integration tests for Request to Vanish

- [#497](https://github.com/cameri/nostream/pull/497) [`e1a7bfb`](https://github.com/cameri/nostream/commit/e1a7bfb16cd8a1a1625664b649fd3e43b3635808) Thanks [@phoenix-server](https://github.com/phoenix-server)! - Replace semantic-release with changesets for explicit PR-level version management. Contributors now add a changeset file per PR; the Changesets Release workflow handles version bumps and GitHub releases.

- [#562](https://github.com/cameri/nostream/pull/562) [`de14f3c`](https://github.com/cameri/nostream/commit/de14f3c8ba94e814ed034d041033373e351be744) Thanks [@Priyanshubhartistm](https://github.com/Priyanshubhartistm)! - Add integration test coverage for NIP-04 encrypted direct messages (kind 4).

- [#525](https://github.com/cameri/nostream/pull/525) [`b09e23a`](https://github.com/cameri/nostream/commit/b09e23a6f1a706b9a1eda0059d97c8f8d2224422) Thanks [@kushagra0902](https://github.com/kushagra0902)! - Dedup keys were taking multiple tags, that was not according to NIP-01 behaviour.

- [#568](https://github.com/cameri/nostream/pull/568) [`c0c1c35`](https://github.com/cameri/nostream/commit/c0c1c35b83a802c04362d046b93c9517623c4993) Thanks [@tharu-jwd](https://github.com/tharu-jwd)! - fix: static mirroring silently drops events when mirror has no limits configured

- [#493](https://github.com/cameri/nostream/pull/493) [`5bf1a58`](https://github.com/cameri/nostream/commit/5bf1a5802b74924a9c9e607115be9db077587b08) Thanks [@kanishka0411](https://github.com/kanishka0411)! - Fix IP spoofing via unconditional trust of x-forwarded-for header

- [#548](https://github.com/cameri/nostream/pull/548) [`00240a9`](https://github.com/cameri/nostream/commit/00240a902c4a5f21a6c699e3ed5d60fb00a44565) Thanks [@CKodidela](https://github.com/CKodidela)! - Support uppercase tag filters (#A-Z) in filter schema validation

- [#566](https://github.com/cameri/nostream/pull/566) [`8eee70f`](https://github.com/cameri/nostream/commit/8eee70fa8ac9945197559cbe42447dbbd8aa2f1c) Thanks [@a-khushal](https://github.com/a-khushal)! - add support for NIP-14 subject tags in text notes, with units tests to validate parsing and repository behavior
