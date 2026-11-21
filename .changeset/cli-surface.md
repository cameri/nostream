---
---

feat(cli): port the `pnpm run cli` surface into `nostream-cli`

The operator line now answers the capture's page, version and unknown-command contract, and
implements the eight missing commands: `start`, `stop`, `update`, `clean`, `info`, `seed`,
`invite`, `setup`, plus `export` and `clean-db` and the `config list`/`set`/`env` family.
`nostream dev` is removed. Three dependencies are added (bech32, flate2, xz2) and four
`EventRepository` methods (`scan_live`, `count_by_criteria`, `delete_by_criteria`,
`delete_all_events`); child processes go through `nostream_services::process`.
