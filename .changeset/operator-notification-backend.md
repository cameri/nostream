---
"nostream": minor
---

feat(admin): operator notification backend with Postgres outbox

Adds transactional outbox dispatch for operator alerts (HTTP, Discord, Slack, Telegram), delivery log, `admin.notifications` settings, event hooks for admission invoices and settings changes, and admin test/history endpoints. Closes #759.
