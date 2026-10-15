---
"nostream": patch
---

fix(deps): resolve open dependabot security alerts

- axios 1.18.0 → 1.20.0: fixes the header-injection, prototype-pollution, ReDoS, NO_PROXY bypass, maxRedirects and HTTP/2 advisories (12 alerts)
- stream-json 2.1.0 → 3.7.0: fixes the prototype-pollution and JSONC re-scan advisories (4 alerts); `EventImportService` updated for the v3 export shape (`streamArray.default.withParserAsStream`)
- pnpm overrides for pinned transitives: proxy-addr ≥ 2.0.8 (IP spoofing via IPv4-mapped IPv6 trust subnet), fast-uri ≥ 3.1.7 (authority injection via unvalidated port), brace-expansion ≥ 1.1.21 / 2.1.7 (quadratic-time CPU DoS), js-yaml 3.15.2 (unbounded merge-key CPU)
- hero-animation: framefields 2.0.8 → 2.1.3 and an `ip@<=2.0.1` override stubbing the unused `ip` package (no fixed release exists; SSRF advisory), since werift@0.23.0 (via node-av) was its only consumer
