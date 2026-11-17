---
'nostream': patch
---

fix(ops): retry a probe alert that could not be saved

When a probe run changed status (ok to failed, or back to ok), the new status was stored first and the alert was written to the notification outbox afterwards. If the database was unavailable at that moment the alert was lost: the next run saw the same status and sent nothing, so an operator never heard about that outage or recovery. The status is now recorded only after the alert has been stored, and a short claim keeps two runs from sending the same alert, so a failed save is retried by the next run.
