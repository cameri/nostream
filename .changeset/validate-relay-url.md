---
"nostream": patch
---

fix(settings): validate `info.relay_url` is a usable absolute URL

`validateSettings()` now rejects a `relay_url` that is not a valid absolute URL, parses with an empty host (scheme-only strings like `localhost:8008`), or uses a protocol other than `ws`/`wss`/`http`/`https`. Previously an invalid value started cleanly and then broke every HTTP request with `500 TypeError: Invalid URL`, including the Admin Console, leaving the bad setting fixable only by editing the file by hand. Found in #824.
