---
"nostream-website": patch
---

Website copy now leads with what each feature does for the user; the technical detail (NIP numbers, protocol names, command flags) moved into (i) info tooltips on hover, focus or tap.

Also ships PR previews: every PR touching the site builds under `/preview/<n>/` and deploys its own worker (`nostream-web-pr-<n>`); the production router worker (new) proxies `ema.tnsor.network/preview/<n>/*` to it, so the preview URL stays on the production domain. Previews are deleted when the PR closes. The production deploy switches from the assets-only worker to the router on the next release — same assets, same domain, plus the preview route.
