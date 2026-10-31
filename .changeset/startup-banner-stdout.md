---
'nostream': patch
---

fix(startup): print the banner as text, and let `LOG_FORMAT=json` opt out of it

`docker compose logs nostream` showed the logo as a single log record with the newlines escaped. The banner and its centred facts now go to stdout as text.

A pipeline that requires every line to parse sets `LOG_FORMAT=json`: the logo is then replaced by one `relay starting` record carrying the same facts as fields (`version`, `supportedNips`, `payments`, `eventStore`, `clientWorkers`, …). Any other value keeps the banner, which is what a person reading the logs wants.
