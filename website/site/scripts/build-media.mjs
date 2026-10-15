// Builds web-sized media in public/ from the Framefields landing film in ../hero-animation.
// First: pnpm run assets && pnpm run render && pnpm run frames   (src/film.ts → output/nostream-hero.mp4)
// Usage: pnpm run media   (HERO_SRC=/path/to/nostream-hero.mp4 to override)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HERO_DIR = path.join(ROOT, '..', 'hero-animation')
const LANDING = path.join(HERO_DIR, 'output')
const MEDIA = path.join(ROOT, 'public', 'media')
const LANDING_POSTER = 'f0130.png'

mkdirSync(MEDIA, { recursive: true })

const planet = path.join(HERO_DIR, 'assets', 'gen', 'planet.png')
if (existsSync(planet)) {
  await sharp(planet).resize(1600).webp({ quality: 78 }).toFile(path.join(MEDIA, 'planet.webp'))
  console.log('planet → public/media')
} else {
  console.warn('skip planet: run `pnpm run assets` in website/hero-animation first')
}

const landingPoster = path.join(LANDING, 'frames', LANDING_POSTER)
if (existsSync(landingPoster)) {
  await sharp(landingPoster).resize(1920).webp({ quality: 90 }).toFile(path.join(MEDIA, 'hero-poster.webp'))
  console.log('hero poster → public/media')
} else {
  console.warn(`skip hero poster: run \`pnpm run frames\` in website/hero-animation (need frames/${LANDING_POSTER})`)
}

const landingVideo = [
  process.env.HERO_SRC,
  path.join(LANDING, 'nostream-hero.mp4'),
  path.join(LANDING, 'nostream-hero-low.mp4'),
].find((p) => p && existsSync(p))

if (landingVideo) {
  // Keep native 1920×1080; light sharpen + high CRF for crisp type in the framed hero.
  execFileSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-i', landingVideo,
      '-vf', 'unsharp=5:5:0.85:5:5:0.0',
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-tune', 'animation',
      '-crf', '15',
      path.join(MEDIA, 'hero.mp4'),
    ],
    { stdio: 'inherit' },
  )
  console.log('hero.mp4 ← landing film (film.ts)')

  const filmMetaPath = path.join(path.dirname(landingVideo), 'film.meta.json')
  const filmMeta = existsSync(filmMetaPath) ? JSON.parse(readFileSync(filmMetaPath, 'utf8')) : null

  if (filmMeta?.nipCount != null) {
    writeFileSync(
      path.join(MEDIA, 'hero.meta.json'),
      `${JSON.stringify({ nipCount: filmMeta.nipCount, generatedAt: filmMeta.generatedAt }, null, 2)}\n`,
    )
    console.log(`hero.meta.json (${filmMeta.nipCount} NIPs)`)
  } else {
    console.warn('skip hero.meta.json: re-render the landing film (`pnpm run render`) so film.meta.json is written')
  }
} else {
  console.warn('skip hero.mp4: run `pnpm run render` in website/hero-animation first')
}

console.log('done → public/media/')
