---
'nostream': patch
---

fix(admin): the settings API cannot change the admin password hash through a parent path

`PATCH /admin/settings` refused a change to `admin.passwordHash`, but it only looked at the path of the request. A request for the path `admin` with a new `admin` object, alone or inside a batch of changes, replaced the object and so wrote or removed `admin.passwordHash` without being refused. Anyone holding a valid admin session, or a copy of its token, could set a password hash they chose, or delete it, without knowing the current password, and the change outlived the session. The API now compares every write-protected value in the settings it is about to save with the stored ones and refuses the whole request when one differs (changed, added or removed), whichever path or batch caused it. Replacing the `admin` object with the same hash in it, and changing any other admin setting, still work.
