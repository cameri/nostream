---
'nostream-website': minor
---

Add a social preview card generated from source.

`website/site/scripts/build-social-card.mjs` renders one composition at two sizes:
`public/media/social-card.png` (1200×630, the site's `og:image`) and
`public/media/github-social-preview.png` (1280×640, the GitHub repository preview).
`Base.astro` now emits the full preview set — `og:image:width`, `og:image:height`,
`og:image:alt`, `twitter:image`, `twitter:title`, `twitter:description`,
`og:site_name`, `og:locale` — and takes an `ogImage` prop that defaults to the card;
`hero-poster.webp` stays the film's poster.

The GitHub preview is uploaded by hand: **Settings → Social preview** in the
repository, which no workflow can set.
