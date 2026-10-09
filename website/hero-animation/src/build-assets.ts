import { mkdir, readFile } from 'node:fs/promises'
import sharp, { type Sharp } from 'sharp'

const RAW = 'assets/icons-raw'
const OUT = 'assets/gen'
const GRAY = '#8a8a8a'

/** simple-icons slug -> colour used on a dark background */
const BRANDS: Record<string, string> = {
  postgresql: '#4169E1',
  redis: '#FF4438',
  docker: '#2496ED',
  typescript: '#3178C6',
  nodedotjs: '#5FA04E',
  bitcoin: '#F7931A',
  lightning: '#792EE5',
  torproject: '#9b59d0',
  github: '#ffffff',
}

const colorize = (svg: string, fill: string) => svg.replace(/<path /g, `<path fill="${fill}" `)

/** Framefields composites textures as premultiplied alpha */
async function save(img: Sharp, out: string) {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255
    data[i] = Math.round(data[i] * a)
    data[i + 1] = Math.round(data[i + 1] * a)
    data[i + 2] = Math.round(data[i + 2] * a)
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(out)
}

async function svgToPng(svg: string, size: number, out: string) {
  await save(sharp(Buffer.from(svg), { density: (72 * size) / 24 }).resize(size, size), out)
}

async function logos() {
  for (const [slug, color] of Object.entries(BRANDS)) {
    const svg = await readFile(`${RAW}/${slug}.svg`, 'utf8')
    await svgToPng(colorize(svg, color), 512, `${OUT}/${slug}.png`)
    await svgToPng(colorize(svg, GRAY), 512, `${OUT}/${slug}-gray.png`)
  }

  const alpha = await sharp('assets/logos/nostr.png')
    .resize(512, 512)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .negate()
    .normalise()
    .extractChannel(0)
    .raw()
    .toBuffer()
  for (const [name, color] of [
    ['nostr', '#a35ee8'],
    ['nostr-gray', GRAY],
  ]) {
    const tinted = await sharp({ create: { width: 512, height: 512, channels: 3, background: color } })
      .joinChannel(alpha, { raw: { width: 512, height: 512, channels: 1 } })
      .png()
      .toBuffer()
    await save(sharp(tinted), `${OUT}/${name}.png`)
  }
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

/** omp-style particle planet: magenta body, white dust, cool rim glow */
async function planet() {
  const S = 1600
  const c = S / 2
  const r = 700
  const rand = rng(7)
  const dots: string[] = []

  for (let i = 0; i < 5200; i++) {
    const a = rand() * Math.PI * 2
    const d = Math.sqrt(rand()) ** 0.55 * r
    const x = c + Math.cos(a) * d
    const y = c + Math.sin(a) * d
    const edge = d / r
    const size = 0.6 + rand() * (edge > 0.85 ? 2.4 : 1.6)
    const op = (0.25 + rand() * 0.75) * (0.35 + edge * 0.65)
    dots.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size.toFixed(2)}" fill="#fff" opacity="${op.toFixed(2)}"/>`,
    )
  }
  for (let i = 0; i < 900; i++) {
    const a = rand() * Math.PI * 2
    const d = r + rand() ** 2 * 70
    const x = c + Math.cos(a) * d
    const y = c + Math.sin(a) * d
    dots.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.5 + rand() * 1.3).toFixed(2)}" fill="#ffd6f0" opacity="${(rand() * 0.6).toFixed(2)}"/>`,
    )
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="body" cx="0.62" cy="0.66" r="0.62">
      <stop offset="0" stop-color="#ff4fa8"/>
      <stop offset="0.45" stop-color="#e0218a"/>
      <stop offset="0.8" stop-color="#7a1166"/>
      <stop offset="1" stop-color="#2a0a2e"/>
    </radialGradient>
    <radialGradient id="rim" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.82" stop-color="#5b7bff" stop-opacity="0"/>
      <stop offset="0.875" stop-color="#7d93ff" stop-opacity="0.55"/>
      <stop offset="0.93" stop-color="#ff6fc4" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="18"/></filter>
  </defs>
  <circle cx="${c}" cy="${c}" r="${r + 90}" fill="url(#rim)" filter="url(#blur)"/>
  <circle cx="${c}" cy="${c}" r="${r}" fill="url(#body)"/>
  ${dots.join('')}
</svg>`
  await save(sharp(Buffer.from(svg)), `${OUT}/planet.png`)
}

async function glow() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <defs><radialGradient id="g"><stop offset="0" stop-color="#ff3d9a" stop-opacity="0.9"/>
  <stop offset="0.35" stop-color="#ff3d9a" stop-opacity="0.35"/><stop offset="1" stop-color="#ff3d9a" stop-opacity="0"/></radialGradient></defs>
  <circle cx="256" cy="256" r="256" fill="url(#g)"/></svg>`
  await save(sharp(Buffer.from(svg)), `${OUT}/glow.png`)
}

/** Faint dot grid that fades out toward the edges */
async function grid() {
  const dots: string[] = []
  for (let y = 24; y < 1080; y += 40) {
    for (let x = 24; x < 1920; x += 40) {
      const dx = (x - 960) / 960
      const dy = (y - 480) / 600
      const op = Math.max(0, 0.22 * (1 - Math.sqrt(dx * dx + dy * dy)))
      if (op > 0.01) {
        dots.push(`<circle cx="${x}" cy="${y}" r="1.1" fill="#fff" opacity="${op.toFixed(3)}"/>`)
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">${dots.join('')}</svg>`
  await save(sharp(Buffer.from(svg)), `${OUT}/grid.png`)
}

/** Loose particle halo around the planet, rotated against it for parallax */
async function sparkles() {
  const S = 2000
  const c = S / 2
  const rand = rng(11)
  const dots: string[] = []
  for (let i = 0; i < 1400; i++) {
    const a = rand() * Math.PI * 2
    const d = 700 + rand() ** 1.6 * 280
    const x = c + Math.cos(a) * d
    const y = c + Math.sin(a) * d
    const color = rand() < 0.3 ? '#ff8cc6' : '#ffffff'
    dots.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.6 + rand() * 1.6).toFixed(2)}" fill="${color}" opacity="${(0.15 + rand() * 0.75).toFixed(2)}"/>`,
    )
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${dots.join('')}</svg>`
  await save(sharp(Buffer.from(svg)), `${OUT}/sparkles.png`)
}

async function grain() {
  const w = 1920
  const h = 1080
  const rand = rng(3)
  const buf = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = rand() < 0.5 ? 255 : 0
    buf[i * 4] = v
    buf[i * 4 + 1] = v
    buf[i * 4 + 2] = v
    buf[i * 4 + 3] = Math.floor(rand() * 10)
  }
  await save(sharp(buf, { raw: { width: w, height: h, channels: 4 } }), `${OUT}/grain.png`)
}

await mkdir(OUT, { recursive: true })
await Promise.all([logos(), planet(), glow(), grain(), grid(), sparkles()])
console.log(`assets written to ${OUT}/`)
