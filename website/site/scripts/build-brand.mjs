// Favicon and static icon sizes from src/assets/logo.png (official mark).
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src', 'assets', 'logo.png')
const PUBLIC = path.join(ROOT, 'public')

if (!existsSync(SRC)) {
  console.warn('build-brand: skip (missing src/assets/logo.png)')
  process.exit(0)
}

mkdirSync(PUBLIC, { recursive: true })

const fit = { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }

await sharp(SRC).resize(32, 32, fit).webp({ quality: 90 }).toFile(path.join(PUBLIC, 'favicon.webp'))
await sharp(SRC).resize(180, 180, fit).webp({ quality: 92 }).toFile(path.join(PUBLIC, 'apple-touch-icon.webp'))

console.log('build-brand: favicon.webp, apple-touch-icon.webp ← src/assets/logo.png')
