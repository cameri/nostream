---
---

chore: add the OSS Scanner build, threat model and patch rules

Enrollment files for Anthropic's OSS Scanner, which builds a project from one Dockerfile and audits it with no network. The build compiles the Rust workspace and its test binaries during the online phase; the threat model names the untrusted input surfaces and the severity bands so a relay-local rating does not have to be guessed; the patch rules bound a proposed fix to the smallest Rust change with a test that fails before it.

No runtime code, no dependency and no workflow edit: the scanner's own run is the only thing these files change. Revert the change to withdraw.
