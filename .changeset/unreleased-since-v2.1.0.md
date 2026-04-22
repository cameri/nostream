---
"nostream": minor
---

Release highlights:

**Features**
- NIP-05 verification support (#463)
- NIP-17 & NIP-44 v2 Modern Direct Messages (#458)
- NIP-62 vanish event support (#418)
- Vanish optimization (#446)
- Export events to JSON Lines format (#451)
- Import .jsonl events into events table (#414)
- Opt-in event retention purge (#359, #412)
- Wipe events table script (#450)
- Nginx reverse proxy in docker-compose (#423)
- Docker DNS pre-flight check for connectivity verification (#398)
- Strict validation for payment callbacks (#426)
- Real home page with templated pages (#409)

**Bug Fixes**
- NIP-01 compliance: deterministic event ordering by event_id
- NIP-01 compliance: correct dedup keys for parametrized replaceable events (#480)
- NIP-01 replaceable event tiebreaker (#416)
- NIP-11 served only on root path instead of relay path (#399)
- Dockerfile: run database migrations in CMD (#422)
- Added expired_at filter to message pipeline (#403)
- Removed unsafe-inline and implemented script nonces for CSP hardening (#394)
- Axios upgraded to fix CVE-2025-62718 (#466)

**Refactors & Chores**
- Migrated validation from Joi to Zod (#484)
- Migrated linting and formatting to Biome (#452)
- Converted user admission to PostgreSQL stored function (#428)
- Upgraded to Node.js 24 LTS (#419)
- Updated dependencies (express, body-parser, js-yaml, axios)
