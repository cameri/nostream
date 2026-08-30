---
"nostream": patch
---

deploy: run production migrations from the relay image

Bake `migrations/` and `knexfile.js` into the runtime image and point the
prod compose migrate service at that image so schema cannot drift from the
code that ships.
