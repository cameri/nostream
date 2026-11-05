---
"nostream-website": patch
---

perf(website): size the hero poster to the box it paints in

`hero-poster.webp` was encoded at 1920×1080 for a box `Hero.astro` caps at
1180×664 CSS px (`min(1180px, 80vw, film-h * 16/9)`), which Lighthouse's
`image-delivery-insight` reported as 36.9 KiB of waste on
`ema.tnsor.network` ([#876](https://github.com/cameri/nostream/issues/876)).
The poster now encodes at 1440×810 — 1.22× that box, enough for a 1.25×
display, so it needs no `devicePixelRatio` branch — and drops from 42,926 B
to 30,878 B, a 28% reduction. SSIM against the old file at the display size
is 0.9968 at 1180×664 and 0.9964 at the larger 1359×764 layout #876 measured.

The social preview is unaffected: `og:image` defaults to the generated
`social-card.png` at 1200×630 in `build-social-card.mjs`, and the hero poster
has no second consumer. `scripts/build-media.mjs` resizes to 1440 so the next
`pnpm run media` keeps the size instead of restoring 1920.
