---
'nostream': patch
---

fix(logging): do not write credential headers to debug logs

Debug logging of incoming requests printed every header, so the admin session cookie, an `Authorization` bearer token, API keys and webhook signatures could be read from the logs and reused. The rate-limit middleware, the WebSocket connection log and the four payment callback controllers now log the headers with the value of every credential-bearing header replaced by `[redacted]`.
