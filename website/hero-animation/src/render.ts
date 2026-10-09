import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadlessMediaRenderer, startPreview } from 'framefields'
import { buildFilm } from './film.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT = path.join(__dirname, '..', 'output')

const [mode = 'video', ...args] = process.argv.slice(2)

if (mode === 'preview') {
  const session = await startPreview(
    { entry: new URL('./film.ts', import.meta.url), export: 'buildFilm' },
    { title: 'nostream hero', open: args.includes('--open') },
  )
  console.log(`\nPreview running at:\n  ${session.url}\n`)
  console.log('Leave the tab open while reviewing. Press Ctrl+C here to stop the server.\n')
  await session.closed
  process.exit(0)
}

const film = await buildFilm()
await fs.mkdir(path.join(OUTPUT, 'frames'), { recursive: true })

if (mode === 'frames') {
  const renderer = new HeadlessMediaRenderer()
  for (const frame of args.map(Number)) {
    const file = path.join(OUTPUT, 'frames', `f${String(frame).padStart(4, '0')}.png`)
    await fs.writeFile(file, await film.renderFrame({ frame, renderer }))
    console.log(file)
  }
  process.exit(0)
}

const [quality = 'very_high'] = args
console.log(`Rendering MP4 at ${quality} quality (requires GPU / WebGPU in Node)…`)
const started = Date.now()
const result = await film.renderVideo({
  outputPath: path.join(OUTPUT, quality === 'very_high' ? 'nostream-hero.mp4' : `nostream-hero-${quality}.mp4`),
  quality,
})
await result.cleanup?.().catch(() => {})
console.log(`${result.filePath} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
process.exit(0)
