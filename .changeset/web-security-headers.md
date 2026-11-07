---
"nostream": minor
---

feat(web): set security headers on every web response

The web app now sends `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, `X-Permitted-Cross-Domain-Policies` and the cross-origin isolation headers through Helmet.

The app's own nonce-based `Content-Security-Policy` remains the single CSP on a response: Helmet's default policy is disabled, because a second CSP would intersect with the app's and block the nonce'd inline scripts the dashboard uses. Embedding the web UI in another origin is now refused by `X-Frame-Options`; the dashboard's own Grafana frame is unaffected.
