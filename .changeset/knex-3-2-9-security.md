---
"nostream": patch
---

fix(deps): bump knex to 3.2.9 for the search_path SQL injection (AIKIDO-2026-10469)

knex 0.0.1–3.2.8 interpolates values passed to `searchPath` for the Postgres
dialect into generated SQL without validating or escaping them, so a value an
attacker can influence becomes an injected identifier. 3.2.9 escapes the double
quotes (#6411); this repository declares `knex` 2.4.2 on both the default branch
and `rewrite/main`.

nostream never sets `searchPath` — `grep -rn "search_path" src/` finds nothing —
so the reachable path is not exercised today, and the bump is taken to remove a
vulnerable dependency from the image, not to close a reachable hole.

knex 3.0.0 drops Node < 16, which the repo already requires (>=24.14.1), and 3.2.0
tightens `RawBinding`. The one compile error that surfaced,
`src/scripts/benchmark-queries.ts` passing `bindings as readonly unknown[]` to
`db.raw()`, is fixed by dropping the assertion: `toSQL().bindings` is already the
accepted type. The emitted JavaScript is byte-identical with and without the
assertion.
