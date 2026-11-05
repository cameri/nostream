---
"nostream-website": patch
---

docs(website): lead with what the relay gives you, not its language

The default meta description and the footer still introduced nostream as "a
Nostr relay written in TypeScript", which describes the implementation and not
the thing a reader gets. The `<title>`, the `og:image:alt` and the repository
description already lead with owning a relay in a social network nobody can
switch off; the two stragglers now match them.

The description feeds `meta[name=description]`, `og:description` and
`twitter:description`, so the link preview changes with it. The technical
substance — PostgreSQL + Redis, Lightning admission, Tor and I2P, admin
console — is unchanged.
