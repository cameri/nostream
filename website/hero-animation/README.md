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

```bash
pnpm run render        # → output/nostream-hero.mp4 (very high bitrate, ~45 MB)
pnpm run render:small  # → output/nostream-hero-low.mp4 (~4 MB, for sharing / PR previews)
```

## Sample frames

```bash
pnpm run frames
# → output/frames/f0130.png …
```

## Edit the story

- Timeline & layout: `src/film.ts` (scene windows `HERO`, `WHAT`, `FLOW`, `FEATURES`, `DEPLOY`)
- Palette & fonts: `src/theme.ts`
- Logos / planet / grid: `src/build-assets.ts` (source SVGs in `assets/icons-raw/`, Nostr PNG in `assets/logos/`)
