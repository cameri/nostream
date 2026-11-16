---
'nostream': patch
---

fix(settings): reload settings when either settings.yaml or settings.json changes

A worker watched only the settings file whose extension existed when it started. The loader reads `settings.yaml` first and falls back to the deprecated `settings.json`, and the admin console and the CLI always write `settings.yaml`, so a worker that started from `settings.json` never reloaded after the yaml file was written. A change such as removing a pubkey from the NIP-98 admin allowlist stayed unseen by that worker until it restarted. The watcher now reloads on a change to either file.
