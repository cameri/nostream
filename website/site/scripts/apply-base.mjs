// Prefix root-absolute asset/link paths in built HTML with the site base.
// Astro's `base` rewrites astro-managed URLs; hand-written hrefs (nav links,
// icons, media) stay root-absolute, so this pass rewrites them for PR previews
// served under /preview/<n>/.
// Usage: SITE_BASE=/preview/42 node scripts/apply-base.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const base = process.env.SITE_BASE
if (!base || base === '/') {
  console.log('apply-base: SITE_BASE not set, nothing to do')
  process.exit(0)
}
const norm = base.endsWith('/') ? base : `${base}/`

const DIST = new URL('../dist/', import.meta.url).pathname

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return p
  })

// HTML attributes that carry site-internal root paths. External (http(s):),
// protocol-relative (//), in-page (#) and already-based paths are skipped.
const ATTRS = ['href', 'src', 'poster', 'content']
let changed = 0

for (const file of walk(DIST)) {
  if (!/\.(html|css)$/.test(file)) continue
  let html = readFileSync(file, 'utf8')
  let out = html
  if (file.endsWith('.html')) {
    // Prefix each root-absolute path with the base; skip paths already based,
    // protocol-relative URLs and pure-fragment links.
    const prefix = norm.replace(/\/$/, '') // '/preview/99'
    out = html
    for (const attr of ATTRS) {
      const re = new RegExp(`(${attr}=)"(/[^"]*)"`, 'gi')
      out = out.replace(re, (m, a, path) => {
        if (path.startsWith(prefix + '/') || path === prefix) return m
        return `${a}"${prefix}${path}"`
      })
    }
    // srcset entries ("path 640w, path 1280w") and CSS url("/...").
    out = out.replace(/(srcset=")([^"]*)(")/gi, (m, a, list, z) => {
      const parts = list.split(',').map((entry) => {
        const [p, ...rest] = entry.trim().split(/\s+/)
        if (!p || !p.startsWith('/') || p.startsWith(prefix + '/')) return entry.trim()
        return [prefix + p, ...rest].join(' ')
      })
      return `${a}${parts.join(', ')}${z}`
    })
    out = out.replace(/url\("(\/[^"]*)"\)/gi, (m, p) =>
      p.startsWith(prefix + '/') ? m : `url("${prefix}${p}")`)
    out = out.replace(/url\('(\/[^']*)'\)/gi, (m, p) =>
      p.startsWith(prefix + '/') ? m : `url('${prefix}${p}')`)
  } else {
    // CSS files: url(/...) only.
    const prefix = norm.replace(/\/$/, '')
    out = html.replace(/url\("(\/[^"]*)"\)/gi, (m, p) =>
      p.startsWith(prefix + '/') ? m : `url("${prefix}${p}")`)
    out = out.replace(/url\('(\/[^']*)'\)/gi, (m, p) =>
      p.startsWith(prefix + '/') ? m : `url('${prefix}${p}')`)
    out = out.replace(/url\((\/[^)]*)\)/gi, (m, p) =>
      p.startsWith(prefix + '/') ? m : `url(${prefix}${p})`)
  }
  if (out !== html) {
    writeFileSync(file, out)
    changed++
  }
}
console.log(`apply-base: rewrote ${changed} files under ${norm}`)
