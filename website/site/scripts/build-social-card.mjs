// Builds the link-preview cards: one composition, two sizes, from the brand mark.
//
//   public/media/social-card.png          1200×630  — the site's og:image
//   public/media/github-social-preview.png 1280×640 — the repository social preview
//
// Both are the same drawing scaled: the wide card is the GitHub one at 1200/1280, so a
// change to the composition lands in both. Nothing is cropped or re-laid-out per size.
//
// Text is drawn as SVG rendered by sharp's librsvg over real woff2 font files, not by a
// system font lookup — a CI runner has no Inter installed, and a fallback face would
// silently change the card. The font files are the ones the site imports
// (@fontsource-variable/inter @fontsource/jetbrains-mono), so the card cannot drift from
// the page's typography.
//
// The backdrop is the page's own: the pink planet at public/media/planet.webp and the 28px
// dot grid from global.css. The home hero's spark stream is deliberately left out — a
// still frame cannot animate, so the particles land under the copy as noise instead of
// drift past it.
//
// Run with the site's other media: `pnpm run media`, or alone with `pnpm run social`.
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOGO = path.join(ROOT, 'src', 'assets', 'logo.png')
const PLANET = path.join(ROOT, 'public', 'media', 'planet.webp')
const MEDIA = path.join(ROOT, 'public', 'media')
const SANS = path.join(ROOT, 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2')
const SANS_ITALIC = path.join(ROOT, 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-italic.woff2')
const MONO = path.join(ROOT, 'node_modules', '@fontsource', 'jetbrains-mono', 'files', 'jetbrains-mono-latin-400-normal.woff2')

// Copied from src/styles/global.css; a card that disagrees with the page is the whole
// defect this file exists to fix.
const BG = '#08080a'
const FG = '#f7f7f7'
const FG2 = '#a8a8a8'
const PINK = '#ff2e88'
const MUTED = '#808080'
const LINE = '#26262a'
const SANS_STACK = "'Inter Variable', Inter, system-ui, sans-serif"
const MONO_STACK = "'JetBrains Mono', ui-monospace, monospace"

const MARK_TOP = 96

const W = 1280
const H = 640

// Layout: the mark sits on the left at the size a card preview actually renders it.
const MARK = 96
const MARK_X = 84
const WORD_X = MARK_X + MARK + 28
const TEXT_X = 84
const TEXT_RIGHT = W - 84

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Font faces resolved from the packages, never from the system. */
const fontFaces = () => {
  for (const f of [SANS, MONO]) {
    if (!existsSync(f)) throw new Error(`build-social-card: missing ${f} — run pnpm install in website/site`)
  }
  const italic = existsSync(SANS_ITALIC) ? `@font-face{font-family:'Card Sans';font-style:italic;src:url('file://${SANS_ITALIC}') format('woff2');font-weight:100 900;font-display:block}` : ''
  return [
    `<style>@font-face{font-family:'Card Sans';src:url('file://${SANS}') format('woff2');font-weight:100 900;font-display:block}`,
    italic,
    `@font-face{font-family:'Card Mono';src:url('file://${MONO}') format('woff2');font-weight:400;font-display:block}</style>`,
  ].join('')
}

/** The 28px dot grid from global.css, faded toward the bottom (body::before). */
const dots = () => {
  const step = 28
  const cells = []
  for (let x = step / 2; x < W; x += step) {
    for (let y = step / 2; y < H; y += step) {
      // Ellipse 120% 80% at 50% 0% — near-opaque at the top, transparent by the bottom.
      const dx = (x - W / 2) / (W * 0.6)
      const dy = y / (H * 0.8)
      const falloff = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy))
      if (falloff <= 0.04) continue
      cells.push(`<circle cx="${x}" cy="${y}" r="1.1" fill="#ffffff" fill-opacity="${(0.07 * falloff).toFixed(3)}"/>`)
    }
  }
  return cells.join('')
}

/** The planet, cropped to its disc and faded by a radial mask, as PlanetBackdrop does. */
const planet = async (width) => {
  if (!existsSync(PLANET)) throw new Error(`build-social-card: missing ${PLANET}`)
  // The asset is 1600×1600 with the disc inset ~5% on each side; crop to the disc so the
  // mask lands on the rim rather than in the padding.
  const disc = Math.round(1600 * 0.88)
  const offset = Math.round((1600 - disc) / 2)
  const size = Math.round(width)
  const base = await sharp(PLANET)
    .extract({ left: offset, top: offset, width: disc, height: disc })
    .resize(size, size, { fit: 'fill' })
    .toBuffer()
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><radialGradient id="m"><stop offset="0.34" stop-color="#fff"/><stop offset="0.66" stop-color="#000"/></radialGradient></defs><rect width="${size}" height="${size}" fill="url(#m)"/></svg>`,
  )
  return sharp(base)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer()
}

const composition = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <g>${dots()}</g>
</svg>
`

const text = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>${fontFaces()}</defs>
  <!-- The name, on the mark's own baseline. A link preview is the one place the
       product is named, so the wordmark leads. -->
  <text x="${WORD_X}" y="${MARK_TOP + MARK / 2 + 26}" font-family="${MONO_STACK}" font-size="46"
        font-weight="600" letter-spacing="-0.9" fill="${FG}">nostream</text>
  <!-- Headline: the outcome, not the implementation. Two lines, because one at this size
       runs into the planet's rim at x≈890 and the last words are read over its glow. -->
  <text x="${TEXT_X}" y="300" font-family="${SANS_STACK}" font-size="47" font-weight="550"
        letter-spacing="-1.4" fill="${FG}">A social network</text>
  <text x="${TEXT_X}" y="352" font-family="${SANS_STACK}" font-size="47" font-weight="550"
        letter-spacing="-1.4" fill="${FG}">nobody can switch off.</text>
  <!-- Ownership line, italic: the same face Family 1 set for the site's emphasis. -->
  <text x="${TEXT_X}" y="404" font-family="${SANS_STACK}" font-size="27" font-weight="450"
        font-style="italic" fill="${PINK}">Own your posts, your followers and your reach</text>
  <rect x="${TEXT_X}" y="438" width="88" height="2" fill="${LINE}"/>
  <!-- What it supports, and its licence. Nothing a reader has to look up. -->
  <text x="${TEXT_X}" y="486" font-family="${MONO_STACK}" font-size="21" font-weight="400"
        fill="${MUTED}" letter-spacing="0.4">Nostr &amp; Marmot protocol support</text>
  <text x="${TEXT_X}" y="522" font-family="${MONO_STACK}" font-size="21" font-weight="400"
        fill="${MUTED}" letter-spacing="0.4">MIT licensed</text>
  <!-- Where to find it. -->
  <text x="${TEXT_X}" y="${H - 52}" font-family="${MONO_STACK}" font-size="20" font-weight="400"
        fill="${MUTED}" letter-spacing="0.6">ema.tnsor.network</text>
</svg>
`

const mark = async (px) => {
  if (!existsSync(LOGO)) throw new Error(`build-social-card: missing ${LOGO}`)
  // The mark is cropped to its pink bar: as a favicon-scale drawing, its bar is the part
  // that reads at card size and the glyph beside the wordmark would repeat the wordmark.
  const meta = await sharp(LOGO).metadata()
  return sharp(LOGO)
    .resize(px, px, { fit: 'contain', background: { r: 8, g: 8, b: 10, alpha: 1 } })
    .png()
    .toBuffer()
    .then((buf) => ({ buf, meta }))
}

const build = async (width, filename) => {
  const base = await sharp(Buffer.from(composition())).png().toBuffer()
  const { buf: logoBuf } = await mark(MARK)
  const planetBuf = await planet(600)
  const card = await sharp(base)
    .composite([
      // Planet low and right, behind the empty half of the card: the copy runs down the
      // left, so nothing pink is ever read over it.
      { input: planetBuf, left: W - 470, top: H - 440 },
      { input: logoBuf, left: MARK_X, top: MARK_TOP },
      { input: Buffer.from(text()) },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer()
  // Each card keeps its own aspect: 1200x630 (1.905:1) for og:image, 1280x640 (2:1) for
  // GitHub. Scaling one from the other changes the ratio, and both services crop to their
  // own ratio, so the mark and the wordmark would drift differently per surface.
  const height = filename === 'social-card.png' ? 630 : 640
  const out = path.join(MEDIA, filename)
  await sharp(card).resize(width, height, { fit: 'fill' }).png({ compressionLevel: 9 }).toFile(out)
  const written = await sharp(out).metadata()
  if (written.width !== width || written.height !== height) {
    throw new Error(`build-social-card: ${filename} came out ${written.width}x${written.height}, expected ${width}x${height}`)
  }
  return out
}

mkdirSync(MEDIA, { recursive: true })

const wide = await build(1200, 'social-card.png')
const github = await build(1280, 'github-social-preview.png')
console.log(`social card → ${path.relative(ROOT, wide)} (1200×630)`)
console.log(`github social preview → ${path.relative(ROOT, github)} (1280×640)`)
