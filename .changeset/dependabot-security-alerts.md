---
"nostream": patch
---

fix(deps): resolve open dependabot security alerts

Bumps axios to ^1.20.0, stream-json to ^3.7.0 (with the v3 ESM import-shape fix in the event import service) and js-yaml to 4.3.2, and adds pnpm overrides forcing proxy-addr >= 2.0.8, fast-uri >= 3.1.7, brace-expansion >= 1.1.21 <2 / >= 2.1.7 <3 and js-yaml 3.x >= 3.15.2 <4. The hero-animation package stubs its unfixable transitive ip <= 2.0.1 (werift chain, unused at runtime) with @stdlib/utils-noop.
