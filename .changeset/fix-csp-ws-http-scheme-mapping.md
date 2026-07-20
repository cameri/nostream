---
"nostream": patch
---

Fix the Content-Security-Policy `connect-src` directive for relays served over plain `ws://`.

The web app factory derived an HTTP(S) origin from the relay's WebSocket URL but mapped
`ws:` to the invalid scheme `':'`, which the WHATWG URL API silently ignores. As a result the
`connect-src` directive kept a `ws://…` entry instead of the intended `http://…` origin for
local/dev, Tor, or reverse-proxied setups. The `ws:` protocol now correctly maps to `http:`.
