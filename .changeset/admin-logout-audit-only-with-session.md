---
'nostream': patch
---

fix(admin): record a logout in the audit history only when the request has a valid session

`POST /admin/logout` is public, because it has to clear the session cookie whoever sends the request, and it wrote an `admin.logout` record to the audit history for every request, with or without a session. Anyone who could reach the admin routes could post to it repeatedly and fill the shared, size-limited audit history in Redis with logouts that never happened, pushing real administrator records out of it. The record is now written only when the request presents a valid session (as a cookie or a Bearer token). A request without one still gets the cookie cleared and a 200, and writes nothing.
