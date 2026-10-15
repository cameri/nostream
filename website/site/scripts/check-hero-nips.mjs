// Ensures public/media/hero.meta.json matches package.json supportedNips.length.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.join(ROOT, '..', '..')
const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const expected = pkg.supportedNips.length
const metaPath = path.join(ROOT, 'public', 'media', 'hero.meta.json')
const heroPath = path.join(ROOT, 'public', 'media', 'hero.mp4')

if (!existsSync(heroPath)) {
  console.warn('check-hero-nips: skip (no public/media/hero.mp4 yet)')
  process.exit(0)
}

if (!existsSync(metaPath)) {
  console.error(
    `check-hero-nips: missing hero.meta.json — run \`pnpm run media\` in website/site after re-rendering the landing film.`,
  )
  process.exit(1)
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
if (meta.nipCount !== expected) {
  console.error(
    `check-hero-nips: hero film shows ${meta.nipCount} NIPs but package.json has ${expected}.`,
  )
  console.error('Re-render: cd website/hero-animation && pnpm run render')
  console.error('Then: cd ../site && pnpm run media')
  process.exit(1)
}

console.log(`check-hero-nips: ok (${expected} NIPs)`)
