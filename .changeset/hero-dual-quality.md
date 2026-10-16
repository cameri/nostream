---
"nostream-website": minor
---

Ship the hero film in two qualities: the page serves a high-res render by default and swaps to a low variant for data-saver clients and small screens (navigator.connection.saveData / effectiveType / viewport + DPR pick). build-media.mjs now emits both variants and records both sources in hero.meta.json.
