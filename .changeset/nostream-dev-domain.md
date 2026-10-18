---
'nostream-website': patch
---

The site now lives at **https://nostream.dev**, and every other host redirects to it over https.

The router worker answers on `nostream.dev` and `www.nostream.dev` as well as the preview
domain, and `CANONICAL_HOST` decides which one serves content: any other host the routes
catch — `www`, or `ema.tnsor.network` for a non-preview path — gets a `301` to the canonical
host, and `http` gets a `301` to the same URL over `https`. One origin serving means one
canonical URL, so `www` and the apex cannot split search ranking by both answering `200`.

Previews deliberately stay on `ema.tnsor.network/preview/<n>/`: that is why the domain
remains bound. A preview build must never sit on the production domain, and a preview's own
`SITE_URL` stays the preview origin so its absolute links and canonical tags cannot claim
`nostream.dev`.

The domain is an input now, not a constant: `SITE_URL` for the build, `CANONICAL_HOST` for
the worker, both set in `deploy-website.yml`. Moving again is two lines rather than a search
through the source, the social card and the README.

**Cloudflare-side setup this needs before it takes effect**: the `nostream.dev` zone must
exist, and both `nostream.dev` and `www.nostream.dev` resolve through the worker's
declared custom domains on the next deploy. Turning on the zone's *Always Use HTTPS*
setting makes the upgrade happen at the edge, before the worker; the worker's own `301`
covers the case where that setting is off.
