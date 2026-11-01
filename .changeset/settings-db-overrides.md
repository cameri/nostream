---
"nostream": minor
---

feat: store relay settings overrides in PostgreSQL when SETTINGS_BACKEND=db

Serialize settings writes, fan out DB override reloads from workers through the primary, close CLI database pools after config commands, bootstrap the settings store for info/invite/configure CLI paths, route moderation and admin PATCH saves through the DB override store, forward SETTINGS_BACKEND in Compose and the env CLI, and fix dotted settings path round-trips for database rows.
