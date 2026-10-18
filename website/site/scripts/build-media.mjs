// Builds web-sized media in public/ from the Framefields landing film in ../hero-animation.
// First: pnpm run assets && pnpm run render && pnpm run frames   (src/film.ts → output/nostream-hero.mp4)
// Usage: pnpm run media   (HERO_SRC=/path/to/nostream-hero.mp4 to override; must ship film.meta.json beside the mp4)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const HERO_DIR = path.join(ROOT, '..', 'hero-animation')
const LANDING = path.join(HERO_DIR, 'output')
const MEDIA = path.join(ROOT, 'public', 'media')
const HERO_META = path.join(MEDIA, 'hero.meta.json')
const LANDING_POSTER = 'f0130.png'
const ADMIN_LANDING = path.join(LANDING, 'admin')
const ADMIN_POSTER = 'f0050.png'

mkdirSync(MEDIA, { recursive: true })

/** film.meta.json must live next to the mp4 we encode — never reuse meta from another render. */
const readFilmMeta = (videoPath) => {
  const metaPath = path.join(path.dirname(videoPath), 'film.meta.json')
  if (!existsSync(metaPath)) return null
  return JSON.parse(readFileSync(metaPath, 'utf8'))
}

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

// The low variant ships beside the full one for mobile / Save-Data. It is the
// previous site video when a fresh high-res render replaces hero.mp4, or the
// low render when that is all hero-animation has produced.
const landingLowVideo = [
  process.env.HERO_LOW_SRC,
  path.join(LANDING, 'nostream-hero-low.mp4'),
  landingVideo === path.join(LANDING, 'nostream-hero-low.mp4') ? null : landingVideo,
].find((p) => p && existsSync(p) && p !== landingVideo)

const encodeHero = (source, outPath, crf) =>
  execFileSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-i', source,
      '-vf', 'unsharp=5:5:0.85:5:5:0.0',
      '-an', '-c:v', 'libx264', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-tune', 'animation',
      '-crf', String(crf),
      outPath,
    ],
    { stdio: 'inherit' },
  )

if (landingVideo) {
  const filmMeta = readFilmMeta(landingVideo)
  if (filmMeta?.nipCount == null) {
    if (existsSync(HERO_META)) unlinkSync(HERO_META)
    console.error(
      `build-media: ${landingVideo} has no film.meta.json beside it — re-render in website/hero-animation (pnpm run render) or pick a source that includes meta.`,
    )
    process.exit(1)
  }

  encodeHero(landingVideo, path.join(MEDIA, 'hero.mp4'), 15)
  console.log('hero.mp4 ← landing film (film.ts)')

  if (landingLowVideo) {
    const lowMeta = readFilmMeta(landingLowVideo)
    if (lowMeta?.nipCount === filmMeta.nipCount) {
      encodeHero(landingLowVideo, path.join(MEDIA, 'hero-low.mp4'), 22)
      console.log('hero-low.mp4 ← landing film (low variant)')
    } else {
      console.warn(
        `skip hero-low.mp4: low source meta (${lowMeta?.nipCount}) disagrees with full source (${filmMeta.nipCount}) — regenerate both renders together`,
      )
    }
  } else {
    console.warn('skip hero-low.mp4: no second source (run `pnpm run render:small` in website/hero-animation)')
  }

  writeFileSync(
    HERO_META,
    `${JSON.stringify(
      {
        nipCount: filmMeta.nipCount,
        generatedAt: filmMeta.generatedAt,
        sourceVideo: path.relative(HERO_DIR, landingVideo),
        ...(landingLowVideo ? { sourceLowVideo: path.relative(HERO_DIR, landingLowVideo) } : {}),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`hero.meta.json (${filmMeta.nipCount} NIPs, source ${path.basename(landingVideo)})`)
} else {
  console.warn('skip hero.mp4: run `pnpm run render` in website/hero-animation first')
}

const adminPoster = path.join(ADMIN_LANDING, 'frames', ADMIN_POSTER)
if (existsSync(adminPoster)) {
  await sharp(adminPoster).resize(1920).webp({ quality: 90 }).toFile(path.join(MEDIA, 'admin-poster.webp'))
  console.log('admin poster → public/media')
} else {
  console.warn(`skip admin poster: run \`pnpm run frames:admin\` in website/hero-animation (need frames/${ADMIN_POSTER})`)
}

const adminVideo = [process.env.ADMIN_SRC, path.join(ADMIN_LANDING, 'nostream-admin.mp4')].find((p) => p && existsSync(p))

if (adminVideo) {
  encodeHero(adminVideo, path.join(MEDIA, 'admin.mp4'), 15)
  console.log('admin.mp4 ← admin film (re-encoded for site / Workers asset limit)')
} else {
  console.warn('skip admin.mp4: run `pnpm run render:admin` in website/hero-animation first')
}

console.log('done → public/media/')
