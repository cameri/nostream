---
'nostream': patch
---

fix(admin): revoke the session token at logout, not only its cookie

`POST /admin/logout` deleted the browser cookie but the session token itself stayed valid until it expired (24 hours by default), because the token was only `<expiresAt>.<signature>` and nothing on the server recorded a logout. A copy of the token kept elsewhere (a `Bearer` client, a log, a proxy) could restore administrator access after sign-out. The token now carries a random session id under the same signature, logout records that id in Redis until the token would have expired, and every admin request checks it, so a logout on one worker ends the session on all of them and ends only that session. If Redis cannot be read the token is refused, and a logout that cannot record the id answers 500 (and still clears the cookie).

Tokens issued before this change have no session id and are refused, so every administrator signs in once more after the upgrade.
