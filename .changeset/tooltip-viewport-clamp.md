---
"nostream-website": patch
---

Info-tip bubbles no longer clip at the viewport edge: the tooltip is centered on its (i) toggle, so near an edge it overflowed. On open (hover, tap or keyboard) the bubble now shifts horizontally to stay inside the viewport, and re-clamps on resize.

Tooltip behavior is delegated at the document level, so every tip is covered even when its per-element listeners would have silently failed to attach.

Site polish from an external review: the community participate cards have their own section heading, the hero headline is real DOM text with a pause control on the film, the console screenshots are labeled as real first-run console data, the honest-advertising copy matches what its warning shows, the nav's active-path comparison strips the deploy base, the get-started phase list explains the skipped numbers, and single-column grids no longer let nowrap content push the page wider than a phone viewport. The hero film is re-rendered at 1080p for the current 25-NIP list.
