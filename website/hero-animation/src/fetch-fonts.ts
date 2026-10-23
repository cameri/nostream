import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(__dirname, '..', 'assets', 'fonts')

const BASE = 'https://raw.githubusercontent.com/google/fonts/main/ofl'

const FONT_FILES: Record<string, string> = {
  'JetBrainsMono.ttf': 'jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
  'Inter.ttf': 'inter/Inter%5Bopsz,wght%5D.ttf',
}

await fs.mkdir(dir, { recursive: true })

for (const [file, src] of Object.entries(FONT_FILES)) {
  const target = path.join(dir, file)
  if (await fs.stat(target).catch(() => null)) {
    console.log(`skip ${target}`)
    continue
  }
  const res = await fetch(`${BASE}/${src}`)
  if (!res.ok) {
    throw new Error(`${src}: HTTP ${res.status}`)
  }
  await fs.writeFile(target, Buffer.from(await res.arrayBuffer()))
  console.log(`wrote ${target}`)
}
