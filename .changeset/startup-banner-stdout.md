---
'nostream': patch
---

fix(startup): print the banner as text instead of one JSON record per line

`docker compose logs nostream` showed the logo as a single log record with the newlines escaped. The banner and its centred facts now go to stdout as text. Nothing is lost for a log pipeline: `createLogger` stringifies an object argument anyway, so every other line is text too — this one is simply printed where a person can read it.
