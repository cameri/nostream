import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadlessMediaRenderer } from 'framefields'
import { buildFilm } from './peering-film.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT = path.join(__dirname, '..', 'output', 'peering')

const [mode = 'frames', ...args] = process.argv.slice(2)
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

const quality = args[0] ?? 'high'
const started = Date.now()
const result = await film.renderVideo({
  outputPath: path.join(
    OUTPUT,
    quality === 'very_high' ? 'nostream-peering.mp4' : `nostream-peering-${quality}.mp4`,
  ),
  quality,
})
await result.cleanup?.().catch(() => {})
console.log(`${result.filePath} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
process.exit(0)
