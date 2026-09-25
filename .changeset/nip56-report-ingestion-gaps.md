---
"nostream": patch
---

fix(nip56): skip targetless report rows, record every p/e target, batch report inserts in one transaction, and warm the WoT graph at boot instead of blocking the first report on a cold-start rebuild
