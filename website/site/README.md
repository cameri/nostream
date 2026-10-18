# nostream website (Astro)

Landing page, docs and changelog for nostream, in the same omp.sh-style dialect as the Framefields films in [`../hero-animation`](../hero-animation).

- `/` framed landing film ([PR #803](https://github.com/cameri/nostream/pull/803) / `film.ts`), sparkles, who it's for, feature pillars, admin & observability, NIPs
- `/get-started` copy-paste build command for the [`run-a-decentralized-social-network-relay`](https://schemaformat.ai/schematics/run-a-decentralized-social-network-relay/SCHEMATIC.md) agent schematic
- `/docs` deploy path chooser plus the repository markdown (README, CLI, CONFIGURATION, deploy docs, Redis, ...) rendered as pages
- `/changelog` rendered from `CHANGELOG.md`
- `/community` maintainer, channels and community guides

Docs, the changelog, the version and the NIP list are read from the repository at build time, so the site never drifts from the code.

## Develop

Needs Node 24+.

```bash
cd website/site
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # → dist/
pnpm check
```

## Film media

Media comes from the landing film in `../hero-animation` (needs `ffmpeg` for `pnpm run media`):

| Asset | Source |
|-------|--------|
| `hero.mp4`, `hero-low.mp4`, `hero-poster.webp`, `hero.meta.json` | Landing film — `src/film.ts` (`pnpm run render`, `pnpm run frames`) |
| `admin.mp4`, `admin-poster.webp` | Operator console film — `src/admin-film.ts` (`pnpm run render:admin`, `pnpm run frames:admin`) |
| `planet.webp` | Particle planet — `src/build-assets.ts` (`pnpm run assets`) |

```bash
cd website/hero-animation
pnpm run assets
pnpm run render && pnpm run frames
pnpm run render:admin && pnpm run frames:admin   # when the admin film or screenshots change
cd ../site
pnpm run media
```

## Brand mark

Official logo: `src/assets/logo.png`. Used in nav/footer, favicon (`pnpm run` / build runs `scripts/build-brand.mjs`), terminal chrome, and the landing film (`website/hero-animation` reads the same file on `pnpm run assets`).

## Admin console screenshots

Still PNGs for the home-page console film live in `src/assets/screens/` (see the README there). The marketing section plays `public/media/admin.mp4`, not the gallery of static shots.
