---
'nostream': patch
---

docs: split the README into a landing page and reference guides

The README had grown to 731 lines and carried a full payments walkthrough, an operations manual and a duplicate of the standalone setup steps. It is now 264 lines: what the relay is, the supported NIPs, requirements, the Docker quick start, and a table pointing at the guide for each task. The payments and operations material moved to `docs/PAYMENTS.md` and `docs/OPERATIONS.md` verbatim, and the standalone setup points at the development quick start in `CONTRIBUTING.md` instead of repeating it. `docs/SETUP.md` now links its payments pointer at the new file. The moved instructions were then checked against the code: the importer write semantics, the admission-fee sum, the knex fallback database name, the LNURL `/callback` convention, and the standalone database and Redis steps. `docker-compose.yml` now forwards `NWC_URL`, and `.env.example` names it correctly.
