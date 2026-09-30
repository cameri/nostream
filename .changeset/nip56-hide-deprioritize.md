---
"nostream": minor
---

feat: execute hide action for actionable NIP-56 reports

Adds `nip56.hideActionableReports` (default `false`): when true, events matching an `actionable`
report (a trusted-moderator report against a valid target) are excluded from REQ/COUNT results. A
pubkey-targeted report hides every event from that pubkey; an event-targeted report hides just that
event. Requires `nip56.enabled` to have any effect. Previously an actionable report was only ever
recorded, never acted on.
