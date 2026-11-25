---
'nostream': patch
---

fix(cli): mask DB_URI and REDIS_URI in `nostream config env` output

`nostream config env list` and `config env get` hide the value of secret keys unless `--show-secrets` is given, but they only recognised keys with SECRET, PASSWORD, API_KEY or PRIVATE_KEY in the name. `DB_URI` and `REDIS_URI` can carry a password (`postgresql://user:password@host/db`), so it was printed as it was. These two keys are now masked like the other secrets, and shown in full with `--show-secrets`.
