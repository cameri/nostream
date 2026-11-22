---
'nostream': patch
---

fix(cli): do not shadow settings.json with the defaults

`nostream start` and `nostream setup` copy the default settings to `.nostr/settings.yaml` when that file is missing. The relay reads `settings.yaml` first and falls back to the deprecated `settings.json` only when there is no yaml, so on a deployment that still had only a `settings.json` the copy replaced every override in it with the defaults: an admission policy such as `nip43.enabled`, payment settings and limits stopped applying, silently. The defaults are now copied only when neither file exists, so a `settings.json` keeps working until the admin console or `nostream config` writes a `settings.yaml`.
