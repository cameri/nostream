# nostream hero animation (Framefields)

Landing-page hero for the upcoming nostream website: **34 s** at 1920×1080, built with [Framefields](https://github.com/gatewai-dev/framefields) and styled after [omp.sh](https://omp.sh/) (near-black with a dot grid, graded white → gray → pink headlines, teal mono labels, numbered stack rail, terminal strips and a particle planet).

1. **Hero**: "Your relay. Your rules. Nostr, wired in.", `$ nostream start`, key stats
2. **What is nostream**: Nostr (protocol) → Relays (servers) → nostream (the relay you own)
3. **How it works**: Nostr clients → nostream core (verify, limits, admission, NIP-11) → PostgreSQL + Redis, with Lightning payments and Docker/Tor deploy. Real `EVENT` / `REQ` / `EOSE` messages, pulses for events in, stored and fanned out, and a stored-event counter
4. **Why nostream**: supported NIPs (counted from the root `package.json`), paid admission, rate limits, import/export, Tor & I2P, admin console
5. **Deploy**: typed `nostream start` with boot output and a "built with" logo row

Logos are official marks: [simple-icons](https://simpleicons.org/) (CC0) for PostgreSQL, Redis, Docker, TypeScript, Node.js, Bitcoin, Lightning, Tor and GitHub, and the [Nostr logo](https://github.com/mbarulli/nostr-logo) (CC0).

This folder is a standalone package; it is not part of the relay build or Docker image.

## Requirements

- **Node.js ≥ 22.20** (Framefields + WebCodecs)
- **WebGPU** (browser preview, or a GPU for headless MP4 export, e.g. Apple Silicon)

```bash
cd website/hero-animation
nvm use          # reads .nvmrc → 22
pnpm install
pnpm run setup   # fonts → assets/fonts/, brand logos + planet → assets/gen/
```

## Preview

```bash
pnpm run preview
```

## Export MP4

NIP counts in the film (hero stats, features slide, relay-core checklist) come from the repo root `package.json` → `supportedNips` via `src/repo-meta.ts`. After changing supported NIPs, re-render and refresh site media:

```bash
pnpm run render        # → output/nostream-hero.mp4 + output/film.meta.json
pnpm run frames        # poster frame for the website
cd ../site && pnpm run media
```

`pnpm run render` writes `output/film.meta.json` (`nipCount`). The Astro site copies that to `public/media/hero.meta.json` and `pnpm build` runs `check-hero-nips.mjs` so a stale hero video fails CI until you re-export.

```bash
pnpm run render:small  # → output/nostream-hero-low.mp4 (~4 MB, for sharing / PR previews)
```

## Sample frames

```bash
pnpm run frames
# → output/frames/f0130.png …
```

## Release film — nostream 3.4.0

A second, operator-focused cut in the same visual dialect: **40 s** at 1920×1080, 30 fps = **1200 frames**, composed in `src/release-film.ts` and rendered headlessly by `src/release-render.ts`.

1. **Problem** (frames 0–150): a relay that is slow under load, and what the user sees — "Your relay says no"
2. **Wait** (150–540): the throttled client. The `OK` carries the wait (`retry after 30 s`), so the client stops guessing and hammering
3. **Docs** (540–760): the operator at 3am — NIP-11 and the relay's behaviour disagree, and the dashboard flags the mismatch
4. **Close** (760–1200): sign-off over the particle planet

```bash
pnpm run render:release        # → output/release/nostream-3.4.0-very_high.mp4 (~14 MB)
pnpm run render:release:small  # → output/release/nostream-3.4.0-low.mp4 (~2.3 MB, for sharing)
pnpm run frames:release        # → output/release/frames/f0060.png … (one still per scene + the end card)
```

## Peering launch film

A 40 s cut for relay peering ([#942](https://github.com/cameri/nostream/issues/942)), in the same dialect as the 3.3.0 release film: **1200 frames** at 1920×1080, composed in `src/peering-film.ts` and rendered by `src/peering-render.ts`. Scene copy and claim traceability live in [`docs/peering-film-copy.md`](docs/peering-film-copy.md) — draft that before changing on-screen text.

1. **People** (frames 0–240): run a relay for your people, not the whole network — peers for its scope, fetches on demand.
2. **Worth** (240–520): your archive is worth something now; sell feeds in sats; flat per-period terms, never per event.
3. **Fast** (520–760): cache peers and an operator-configured window (e.g. the last hour); hot feed near readers.
4. **Middle** (760–980): relays that only talk to relays — archive/cache infrastructure, edges facing users.
5. **Close** (980–1200): today every relay tries to be everything → one thing well; the network assembles the rest.

```bash
pnpm run render:peering        # → output/peering/nostream-peering.mp4
pnpm run render:peering:small  # → output/peering/nostream-peering-low.mp4
pnpm run frames:peering        # → output/peering/frames/f0150.png … (one still per scene + the end card)
cd ../site && pnpm run media   # → public/media/peering.mp4, peering-poster.webp (home #peering)
```

## Admin console film

**35 s** at 1920×1080. Opens on “Operator Console”, then each feature is a short explanation on the landing-hero backdrop (dot grid, planet, sparkle halo) followed by that screenshot full frame: metrics, settings, NIP-66, notifications.

1. **Title** — “Operator Console”
2. **Metrics** — explanation, then `metrices.png` full frame
3. **Settings** — explanation, then `settings-editor.png` full frame
4. **NIP-66** — explanation, then `nip66.png` full frame
5. **Alerts** — explanation, then `notification.png` full frame
6. **Close** — back on the hero backdrop

```bash
pnpm run preview:admin         # live preview
pnpm run render:admin          # → output/admin/nostream-admin.mp4
pnpm run render:admin:small    # → output/admin/nostream-admin-low.mp4
pnpm run frames:admin          # stills for review / posters
```

After changing the admin film, run `pnpm run media` in `website/site` to re-encode `public/media/admin.mp4` (Cloudflare Workers assets must stay under 25 MiB — do not copy the raw Framefields mp4 into `public/`).

## Edit the story

- Timeline & layout: `src/film.ts` (scene windows `HERO`, `WHAT`, `FLOW`, `FEATURES`, `DEPLOY`)
- Release film: `src/release-film.ts` (scene windows `PROBLEM`, `WAIT`, `DOCS`, `CLOSE`), rendered by `src/release-render.ts`
- Peering film: `src/peering-film.ts` (scene windows `PEOPLE`, `WORTH`, `FAST`, `MIDDLE`, `CLOSE`), rendered by `src/peering-render.ts`
- Admin film: `src/admin-film.ts`, rendered by `src/admin-render.ts`
- Palette & fonts: `src/theme.ts`
- Logos / planet / grid: `src/build-assets.ts` (source SVGs in `assets/icons-raw/`, Nostr PNG in `assets/logos/`)
- Admin screenshots: `website/site/src/assets/screens/*.png`
