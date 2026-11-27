---
'nostream': patch
---

fix(nip56): start the hidden-content cache on every worker, not only when reporting is on at boot

A worker started the cache of hidden report targets only if `nip56.enabled` was true when it booted. On a relay that turned reporting and `hideActionableReports` on later, through a settings reload or a backup restore, the live-delivery check was active but the cache stayed empty, so reported pubkeys and events were still sent to open subscriptions until the next restart. The cache now starts on every worker. Each tick still reads the settings first and queries the database only while `hideActionableReports` is on, so a relay that does not use reporting pays no database cost.
