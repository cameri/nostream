---
"nostream": patch
---

deploy: minimal server bootstrap with optional settings overrides

Add deploy/bootstrap.sh, document what operators must keep locally vs what
ships in the image, and stop seeding a full settings.yaml on first boot so
release defaults merge with optional overrides only.
