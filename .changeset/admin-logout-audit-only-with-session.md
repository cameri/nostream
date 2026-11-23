---
'nostream': patch
---

fix(admin): record a logout in the audit history only when it ends a session

`POST /admin/logout` is public, because it has to clear the session cookie whoever sends the request, and it wrote an `admin.logout` record to the audit history for every request, with or without a session. Anyone who could reach the admin routes could post to it repeatedly and fill the shared, size-limited audit history in Redis with logouts that never happened, pushing real administrator records out of it. The record is now written only by the logout that ends a session: a request with a valid session (as a cookie or a Bearer token) whose session had not been revoked yet. Revoking a session now tells the caller whether it was this call that did it, in one atomic step, so a copy of a token that was already logged out, or several logouts of the same session at once, write nothing more. Every such request still gets the cookie cleared and a 200.
