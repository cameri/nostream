import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Composition, Layer, LayerAnimation, Vignette } from 'framefields'
import {
  BG,
  BODY,
  DURATION,
  FG,
  FG_2,
  FONT_MONO,
  FONT_SANS,
  FPS,
  H,
  LINE,
  MUTED,
  monoWidth,
  PANEL,
  PANEL_BORDER,
  PINK,
  PINK_DIM,
  TEAL,
  W,
  WIRE,
} from './theme.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const asset = (name: string) => path.join(ROOT, 'assets', 'gen', `${name}.png`)
const NIP_COUNT = String(
  JSON.parse(readFileSync(path.join(ROOT, '..', '..', 'package.json'), 'utf8')).supportedNips.length,
)

type Node =
  | ReturnType<typeof Layer.box>
  | ReturnType<typeof Layer.text>
  | ReturnType<typeof Layer.image>
  | ReturnType<typeof Layer.shape>
type Key = [number, number] | [number, number, string]
type Window = [number, number]

/** Scene boundaries (frames) */
const HERO = { start: 0, end: 165 }
const WHAT = { start: 165, end: 345 }
const FLOW = { start: 345, end: 675 }
const FEATURES = { start: 675, end: 855 }
const DEPLOY = { start: 855, end: DURATION }
const LAST = DURATION - 1
/** Event round-trips in the flow scene */
const CYCLES = [FLOW.start + 92, FLOW.start + 166, FLOW.start + 240]

/** Sort and merge windows that overlap or sit too close to fade between */
function mergeWindows(windows: Window[], gap: number): Window[] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0])
  const out: Window[] = []
  for (const w of sorted) {
    const prev = out[out.length - 1]
    if (prev && w[0] <= prev[1] + gap) {
      prev[1] = Math.max(prev[1], w[1])
    } else {
      out.push([...w])
    }
  }
  return out
}

/** Opacity keys for [start, end) windows; end >= DURATION holds to the last frame */
function windowKeys(windows: Window[], peak = 1, inF = 14, outF = 14): Key[] {
  const keys: Key[] = []
  let last = -1
  const push = (f: number, v: number, ease?: string) => {
    const frame = Math.max(0, Math.min(LAST, Math.round(f)))
    if (frame <= last) {
      return
    }
    keys.push(ease ? [frame, v, ease] : [frame, v])
    last = frame
  }
  const merged = mergeWindows(windows, inF + outF)
  if (merged[0][0] > 0) {
    push(0, 0)
  }
  for (const [start, end] of merged) {
    push(start, 0)
    push(start + inF, peak, 'power2.out')
    if (end < DURATION) {
      push(end - outF, peak)
      push(end, 0, 'power2.in')
    }
  }
  return keys
}

interface Show {
  start: number
  end?: number
  dy?: number
  inF?: number
  outF?: number
  peak?: number
}

/** Fade (and optionally rise) a layer in for a window */
function show(y: number, { start, end = DURATION, dy = 0, inF = 14, outF = 14, peak = 1 }: Show) {
  const anim = LayerAnimation.create().keys('opacity', windowKeys([[start, end]], peak, inF, outF))
  if (dy) {
    const yk: Key[] = [
      [start, y + dy],
      [start + inF + 8, y, 'power3.out'],
    ]
    if (end < DURATION) {
      yk.push([end - outF, y])
      yk.push([end, y - dy * 0.6, 'power2.in'])
    }
    anim.keys('y', yk)
  }
  return anim
}

const mono = (text: string, x: number, y: number, size: number, opts: Record<string, unknown> = {}) =>
  Layer.text(text, {
    position: 'absolute',
    x,
    y,
    fontFamily: FONT_MONO,
    fontSize: size,
    fill: BODY,
    opacity: 0,
    ...opts,
  })

const sans = (text: string, x: number, y: number, size: number, opts: Record<string, unknown> = {}) =>
  Layer.text(text, {
    position: 'absolute',
    x,
    y,
    fontFamily: FONT_SANS,
    fontSize: size,
    fontWeight: 700,
    fill: FG,
    opacity: 0,
    ...opts,
  })

const rect = (x: number, y: number, w: number, h: number, opts: Record<string, unknown> = {}) =>
  Layer.box({ position: 'absolute', x, y, width: w, height: h, opacity: 0, ...opts })

const img = (name: string, x: number, y: number, size: number) =>
  Layer.image(asset(name), { position: 'absolute', x, y, width: size, height: size, opacity: 0 })

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  if (x1 === x2 || y1 === y2) {
    return `M ${x1} ${y1} L ${x2} ${y2}`
  }
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
}

const pathLayer = (d: string, color: string, width: number, opts: Record<string, unknown> = {}) =>
  Layer.shape('path', {
    position: 'absolute',
    x: 0,
    y: 0,
    width: W,
    height: H,
    d,
    fillType: 'none',
    strokeColor: color,
    strokeWidth: width,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    opacity: 0,
    ...opts,
  } as never)

/** Drawn check mark (the font renderer treats ✓ as an emoji) */
const check = (x: number, y: number, size: number) =>
  pathLayer(
    `M ${x} ${y + size * 0.55} L ${x + size * 0.38} ${y + size * 0.9} L ${x + size} ${y + size * 0.1}`,
    PINK,
    2.5,
  )

const ring = (cx: number, cy: number, r: number, color: string, width: number) =>
  pathLayer(`M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy}`, color, width)

export async function buildFilm(): Promise<Composition> {
  const film = new Composition({
    width: W,
    height: H,
    fps: FPS,
    durationFrames: DURATION,
    backgroundColor: BG,
    fonts: [path.join(ROOT, 'assets/fonts/JetBrainsMono.ttf'), path.join(ROOT, 'assets/fonts/Inter.ttf')],
  })
  const add = (node: Node, anim: LayerAnimation) => film.add(node.animate(anim) as never)

  /** Rail highlight windows, filled in by each scene and drawn at the end */
  const lit: Record<string, Window[]> = {
    nostr: [],
    nostream: [],
    postgresql: [],
    redis: [],
    lightning: [],
    docker: [],
  }
  const light = (name: keyof typeof lit, start: number, end: number) => lit[name].push([start, end])

  // ── Backdrop: dot grid, planet, particle halo ─────────────────────────────
  add(
    Layer.image(asset('grid'), { position: 'absolute', x: 0, y: 0, width: W, height: H, opacity: 0 }),
    show(0, { start: 0, inF: 30 }),
  )

  const planetSize = 1700
  const haloSize = planetSize * (2000 / 1600)
  const planetY: Key[] = [
    [0, 1100],
    [60, 520, 'power3.out'],
    [HERO.end - 10, 505],
    [WHAT.start + 25, 700, 'power2.inOut'],
    [WHAT.end - 20, 710],
    [FLOW.start + 20, 790, 'power2.inOut'],
    [FEATURES.end - 20, 820],
    [DEPLOY.start + 30, 500, 'power3.out'],
    [LAST, 480],
  ]
  const planetOpacity: Key[] = [
    [0, 0],
    [30, 1],
    [HERO.end - 10, 1],
    [WHAT.start + 25, 0.6],
    [WHAT.end - 20, 0.6],
    [FLOW.start + 20, 0.35],
    [FEATURES.end - 20, 0.35],
    [DEPLOY.start + 30, 1],
  ]
  add(
    Layer.image(asset('planet'), {
      position: 'absolute',
      x: 1000,
      y: 1100,
      width: planetSize,
      height: planetSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys('y', planetY)
      .keys('opacity', planetOpacity)
      .fromTo('rotation', 0, 50, { start: 0, end: LAST, ease: 'linear' }),
  )
  const haloOffset = (haloSize - planetSize) / 2
  add(
    Layer.image(asset('sparkles'), {
      position: 'absolute',
      x: 1000 - haloOffset,
      y: 1100 - haloOffset,
      width: haloSize,
      height: haloSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys(
        'y',
        planetY.map(([f, v, e]) => (e ? [f, v - haloOffset, e] : [f, v - haloOffset]) as Key),
      )
      .keys('opacity', planetOpacity)
      .fromTo('rotation', 0, -35, { start: 0, end: LAST, ease: 'linear' }),
  )

  // ── Persistent chrome: nav, footer ──────────────────────────────────────
  const always = { start: 0, inF: 12 }
  add(rect(120, 45, 16, 16, { background: PINK }), show(45, always))
  add(mono('nostream', 146, 37, 22, { fill: FG, fontWeight: 700 }), show(37, always))

  const navSize = 14
  const navSpacing = 2
  let navX = 1800
  for (const label of ['GITHUB', 'NIPS', 'DOCS']) {
    navX -= monoWidth(label, navSize, navSpacing)
    add(mono(label, navX, 42, navSize, { letterSpacing: navSpacing, fill: BODY }), show(42, always))
    if (label === 'GITHUB') {
      add(img('github', navX - 28, 40, 20), show(40, { ...always, peak: 0.75 }))
      navX -= 28
    }
    navX -= 44
  }

  const footerRight = 'OPEN SOURCE  ·  MIT LICENSE  ·  GITHUB.COM/CAMERI/NOSTREAM'
  add(mono('nostream', 120, 1022, 18, { fill: FG, fontWeight: 700 }), show(1022, always))
  add(
    mono(footerRight, 1800 - monoWidth(footerRight, 13, 2), 1025, 13, { letterSpacing: 2, fill: BODY }),
    show(1025, always),
  )

  const hx = 160
  const sceneLabel = (text: string, y: number, start: number, end: number) =>
    add(mono(text, hx, y, 15, { letterSpacing: 3, fill: TEAL }), show(y, { start, end, dy: 12 }))

  const card = (x: number, y: number, w: number, h: number, start: number, end: number, accent = false) =>
    add(
      rect(x, y, w, h, {
        background: PANEL,
        borderColor: accent ? PINK : PANEL_BORDER,
        borderWidth: accent ? 2 : 1,
        borderRadius: 8,
      }),
      show(y, { start, end, dy: 18 }),
    )

  const glow = (cx: number, cy: number, size: number, windows: Window[], peak: number) =>
    add(
      Layer.image(asset('glow'), {
        position: 'absolute',
        x: cx - size / 2,
        y: cy - size / 2,
        width: size,
        height: size,
        opacity: 0,
      }),
      LayerAnimation.create().keys('opacity', windowKeys(windows, peak, 20)),
    )

  /** A pink comet with a soft halo travelling along a path */
  const pulse = (d: string, start: number, dur = 24) => {
    for (const [color, width, peak] of [
      [PINK_DIM, 10, 0.9],
      [PINK, 3.5, 1],
    ] as const) {
      add(
        pathLayer(d, color, width, { trimStart: 0, trimEnd: 0 }),
        LayerAnimation.create()
          .keys('opacity', [
            [start - 1, 0],
            [start, peak],
            [start + dur - 2, peak],
            [start + dur, 0],
          ])
          .keys('trimEnd', [
            [start, 0],
            [start + dur * 0.75, 1, 'power1.inOut'],
          ])
          .keys('trimStart', [
            [start + dur * 0.25, 0],
            [start + dur, 1, 'power1.inOut'],
          ]),
      )
    }
  }

  const drawWire = (d: string, start: number, end: number, color = WIRE, width = 2) =>
    add(
      pathLayer(d, color, width, { trimEnd: 0 }),
      LayerAnimation.create()
        .keys('opacity', windowKeys([[start, end]], 1, 4))
        .keys('trimEnd', [
          [start, 0],
          [start + 22, 1, 'power2.out'],
        ]),
    )

  const tabs = (y: number, start: number, end: number) => {
    let x = hx
    ;['DOCKER', 'CLI', 'TOR'].forEach((label, i) => {
      const w = monoWidth(label, 14, 2)
      add(
        mono(label, x, y, 14, { letterSpacing: 2, fill: i === 0 ? FG : MUTED }),
        show(y, { start: start + i * 3, end }),
      )
      if (i === 0) {
        add(rect(x, y + 26, w - 2, 2, { background: PINK }), show(y + 26, { start: start + 6, end }))
      }
      x += w + 36
    })
  }

  const copyButton = (right: number, y: number, start: number, end: number) => {
    add(
      rect(right - 84, y, 80, 34, { borderColor: PANEL_BORDER, borderWidth: 1, borderRadius: 3 }),
      show(y, { start, end }),
    )
    add(mono('COPY', right - 68, y + 9, 13, { letterSpacing: 2, fill: BODY }), show(y + 9, { start, end }))
  }

  // ── Scene 1 · Hero ─────────────────────────────────────────────────────
  const heroOut = HERO.end
  light('nostream', 24, heroOut)
  sceneLabel('NOSTREAM  ·  OPEN-SOURCE NOSTR RELAY', 196, 6, heroOut)
  const headline: [string, string][] = [
    ['Your relay.', FG],
    ['Your rules.', FG_2],
    ['Nostr, wired in.', PINK],
  ]
  headline.forEach(([text, fill], i) => {
    const y = 228 + i * 112
    add(
      sans(text, hx - 6, y, 108, { fill, letterSpacing: -4, fontWeight: 800 }),
      show(y, { start: 12 + i * 9, end: heroOut, dy: 40, inF: 18 }),
    )
  })

  const bodyY1 = 606
  const bodyY2 = 640
  add(
    mono('A production-ready Nostr relay, written in TypeScript.', hx, bodyY1, 21, { fill: BODY }),
    show(bodyY1, { start: 42, end: heroOut, dy: 14 }),
  )
  const prefix = 'Your server. Your data. No '
  const struck = 'middleman'
  const strikeX = hx + monoWidth(prefix, 21)
  add(mono(prefix, hx, bodyY2, 21, { fill: BODY }), show(bodyY2, { start: 48, end: heroOut, dy: 14 }))
  add(mono(struck, strikeX, bodyY2, 21, { fill: MUTED }), show(bodyY2, { start: 48, end: heroOut, dy: 14 }))
  add(
    mono('.', strikeX + monoWidth(struck, 21), bodyY2, 21, { fill: BODY }),
    show(bodyY2, { start: 48, end: heroOut, dy: 14 }),
  )
  add(
    rect(strikeX - 2, bodyY2 + 14, 0, 2, { background: PINK }),
    show(bodyY2 + 14, { start: 66, end: heroOut }).keys('width', [
      [66, 0],
      [80, monoWidth(struck, 21) + 4, 'power2.out'],
    ]),
  )

  tabs(708, 62, heroOut)
  const heroTerm = { y: 744, w: 780 }
  add(
    rect(hx, heroTerm.y, heroTerm.w, 70, {
      background: PANEL,
      borderColor: PANEL_BORDER,
      borderWidth: 1,
      borderRadius: 4,
    }),
    show(heroTerm.y, { start: 68, end: heroOut }),
  )
  add(
    mono('$', hx + 26, heroTerm.y + 20, 23, { fill: PINK, fontWeight: 700 }),
    show(heroTerm.y + 20, { start: 72, end: heroOut }),
  )
  add(
    mono('nostream start', hx + 58, heroTerm.y + 20, 23, { fill: FG }),
    show(heroTerm.y + 20, { start: 76, end: heroOut, inF: 2 }).typewriter(78, 106, 'linear'),
  )
  add(
    rect(hx + 252, heroTerm.y + 20, 12, 28, { background: PINK }),
    LayerAnimation.create().keys(
      'opacity',
      windowKeys(
        [
          [106, 118],
          [128, 140],
          [150, heroOut],
        ],
        0.9,
        2,
        2,
      ),
    ),
  )
  copyButton(hx + heroTerm.w - 18, heroTerm.y + 18, 74, heroOut)

  const stats: [string, string][] = [
    [NIP_COUNT, 'NIPS SUPPORTED'],
    ['6', 'LIGHTNING PROCESSORS'],
    ['MIT', 'OPEN SOURCE'],
  ]
  stats.forEach(([value, label], i) => {
    const x = hx + i * 270
    const s = 96 + i * 8
    add(rect(x, 868, 1, 62, { background: LINE }), show(868, { start: s, end: heroOut }))
    add(
      sans(value, x + 20, 862, 40, { fill: FG, fontWeight: 800, letterSpacing: -1 }),
      show(862, { start: s, end: heroOut, dy: 12 }),
    )
    add(mono(label, x + 20, 914, 13, { letterSpacing: 2, fill: MUTED }), show(914, { start: s + 4, end: heroOut }))
  })

  // ── Scene 2 · What is nostream ──────────────────────────────────────────
  const w0 = WHAT.start
  const wEnd = WHAT.end
  sceneLabel('01  —  WHAT IS NOSTREAM', 150, w0 + 4, wEnd)
  add(
    sans('Nostr runs on relays.', hx - 4, 180, 82, { letterSpacing: -3, fontWeight: 800 }),
    show(180, { start: w0 + 8, end: wEnd, dy: 30, inF: 18 }),
  )
  add(
    sans('nostream is the one you own.', hx - 4, 272, 82, { letterSpacing: -3, fontWeight: 800, fill: PINK }),
    show(272, { start: w0 + 16, end: wEnd, dy: 30, inF: 18 }),
  )

  const whatCards = [
    {
      num: '01',
      title: 'Nostr',
      body: 'An open protocol for social\napps. You hold your keys,\nso no company owns you.',
      tag: 'keys  ·  signed events  ·  NIPs',
    },
    {
      num: '02',
      title: 'Relays',
      body: 'Servers that receive, store\nand forward signed events\nbetween clients.',
      tag: 'wss://  ·  store  ·  forward',
    },
    {
      num: '03',
      title: 'nostream',
      body: 'A production-ready relay\nin TypeScript that you\ndeploy and control.',
      tag: 'self-hosted  ·  open source',
    },
  ]
  const wc = { y: 430, w: 440, h: 330, gap: 140 }
  whatCards.forEach(({ num, title, body, tag }, i) => {
    const x = hx + i * (wc.w + wc.gap)
    const s = w0 + 30 + i * 22
    const at = (y: number, delay = 4) => show(y, { start: s + delay, end: wEnd, dy: 18 })
    const accent = i === 2
    if (accent) {
      glow(x + wc.w / 2, wc.y + wc.h / 2, 900, [[s + 10, wEnd]], 0.32)
    }
    card(x, wc.y, wc.w, wc.h, s, wEnd, accent)
    add(
      mono(num, x + wc.w - 150, wc.y + 6, 120, { fill: '#17171b', fontWeight: 800, letterSpacing: -6 }),
      at(wc.y + 6, 2),
    )
    const iy = wc.y + 36
    if (i === 0) {
      add(img('nostr', x + 36, iy, 68), at(iy))
    }
    if (i === 1) {
      const cx = x + 70
      const cy = iy + 34
      add(ring(cx, cy, 32, WIRE, 2), show(0, { start: s + 4, end: wEnd }))
      add(ring(cx, cy, 20, BODY, 2), show(0, { start: s + 4, end: wEnd }))
      add(rect(cx - 6, cy - 6, 12, 12, { background: PINK, borderRadius: 6 }), at(iy))
    }
    if (i === 2) {
      add(rect(x + 44, iy + 12, 44, 44, { background: PINK, borderRadius: 2 }), at(iy))
    }
    light(i === 0 ? 'nostr' : 'nostream', s, s + 50)
    add(sans(title, x + 36, wc.y + 128, 38, { letterSpacing: -1, fill: accent ? PINK : FG }), at(wc.y + 128, 6))
    add(mono(body, x + 36, wc.y + 186, 17, { fill: BODY, lineHeight: 28 }), at(wc.y + 186, 8))
    add(rect(x + 36, wc.y + wc.h - 58, wc.w - 72, 1, { background: LINE }), at(wc.y + wc.h - 58, 8))
    add(
      mono(tag, x + 36, wc.y + wc.h - 40, 14, { fill: accent ? PINK : MUTED, letterSpacing: 1 }),
      at(wc.y + wc.h - 40, 10),
    )
  })
  for (let i = 0; i < 2; i++) {
    const x1 = hx + wc.w + i * (wc.w + wc.gap) + 20
    const x2 = x1 + wc.gap - 40
    const y = wc.y + wc.h / 2
    const s = w0 + 52 + i * 22
    drawWire(`M ${x1} ${y} L ${x2} ${y}`, s, wEnd, BODY, 2)
    drawWire(`M ${x2 - 12} ${y - 10} L ${x2} ${y} L ${x2 - 12} ${y + 10}`, s + 14, wEnd, BODY, 2)
    for (const t of [w0 + 100, w0 + 150]) {
      pulse(`M ${x1} ${y} L ${x2} ${y}`, t + i * 18, 20)
    }
  }

  // ── Scene 3 · How nostream works ────────────────────────────────────────
  const f0 = FLOW.start
  const fEnd = FLOW.end
  sceneLabel('02  —  HOW NOSTREAM WORKS', 138, f0 + 4, fEnd)
  add(
    sans('Clients publish.', hx - 3, 166, 52, { letterSpacing: -1.5 }),
    show(166, { start: f0 + 8, end: fEnd, dy: 20 }),
  )
  add(
    sans('nostream verifies, stores & streams.', hx - 3, 226, 52, { letterSpacing: -1.5, fill: PINK }),
    show(226, { start: f0 + 14, end: fEnd, dy: 20 }),
  )
  const atF = (start: number, y: number) => show(y, { start, end: fEnd, dy: 16 })

  const core = { x: 760, y: 500, w: 400, h: 280 }
  const coreStart = f0 + 18
  glow(core.x + core.w / 2, core.y + core.h / 2 - 40, 780, [[coreStart, fEnd]], 0.35)
  card(core.x, core.y, core.w, core.h, coreStart, fEnd, true)
  add(rect(core.x + 30, core.y + 34, 18, 18, { background: PINK }), atF(coreStart + 4, core.y + 34))
  add(sans('nostream', core.x + 60, core.y + 20, 36, { letterSpacing: -1 }), atF(coreStart + 4, core.y + 20))
  add(
    mono('RELAY CORE', core.x + 30, core.y + 72, 13, { letterSpacing: 3, fill: TEAL }),
    atF(coreStart + 6, core.y + 72),
  )
  add(rect(core.x + 30, core.y + 100, core.w - 60, 1, { background: LINE }), atF(coreStart + 6, core.y + 100))
  const checks = [
    'verify id + schnorr signature',
    'rate limits · spam rules · PoW',
    'paid admission · NIP-42 auth',
    'NIP-11 relay information',
  ]
  checks.forEach((text, i) => {
    const y = core.y + 116 + i * 30
    const tick = CYCLES[0] + 24 + i * 6
    add(mono('·', core.x + 30, y, 16, { fill: MUTED }), show(y, { start: coreStart + 8, end: tick + 2, outF: 4 }))
    add(mono(text, core.x + 56, y, 16, { fill: MUTED }), show(y, { start: coreStart + 8, end: tick + 2, outF: 4 }))
    add(check(core.x + 28, y + 4, 13), show(0, { start: tick, end: fEnd, inF: 6 }))
    add(mono(text, core.x + 56, y, 16, { fill: FG }), show(y, { start: tick, end: fEnd, inF: 6 }))
  })
  add(img('typescript', core.x + 30, core.y + 242, 22), atF(coreStart + 10, core.y + 242))
  add(img('nodedotjs', core.x + 60, core.y + 242, 22), atF(coreStart + 10, core.y + 242))
  add(mono('TypeScript · Node.js', core.x + 94, core.y + 245, 14, { fill: MUTED }), atF(coreStart + 10, core.y + 245))

  // Clients
  const clients = [
    { name: 'Damus', sub: 'iOS' },
    { name: 'Amethyst', sub: 'Android' },
    { name: 'Primal', sub: 'web' },
  ]
  const cliX = 200
  const cliW = 320
  add(mono('NOSTR CLIENTS', cliX, 436, 13, { letterSpacing: 3, fill: MUTED }), atF(f0 + 30, 436))
  const clientWires: { d: string; back: string }[] = []
  clients.forEach(({ name, sub }, i) => {
    const y = 470 + i * 130
    const s = f0 + 30 + i * 6
    card(cliX, y, cliW, 88, s, fEnd)
    add(img('nostr', cliX + 18, y + 20, 48), atF(s + 2, y + 20))
    add(sans(name, cliX + 82, y + 16, 24, { letterSpacing: -0.5 }), atF(s + 2, y + 16))
    add(mono(`${sub} client · wss://`, cliX + 82, y + 52, 14, { fill: MUTED }), atF(s + 2, y + 52))
    const sy = y + 44
    const ey = core.y + 80 + i * 60
    clientWires.push({ d: curve(cliX + cliW, sy, core.x, ey), back: curve(core.x, ey, cliX + cliW, sy) })
  })

  // Protocol messages
  const eventCard = { x: cliX, y: 300, w: cliW, h: 120 }
  const evStart = CYCLES[0] - 14
  card(eventCard.x, eventCard.y, eventCard.w, eventCard.h, evStart, fEnd)
  add(mono('["EVENT", {', eventCard.x + 20, eventCard.y + 16, 15, { fill: PINK }), atF(evStart + 2, eventCard.y + 16))
  add(
    mono('  "kind": 1,\n  "content": "gm nostr",\n  "sig": "a3f9…c41e" }]', eventCard.x + 20, eventCard.y + 38, 15, {
      fill: BODY,
      lineHeight: 22,
    }),
    atF(evStart + 4, eventCard.y + 38),
  )

  const stX = 1400
  const stW = 330
  const reqCard = { x: stX, y: 300, w: stW, h: 120 }
  const reqStart = CYCLES[0] + 44
  card(reqCard.x, reqCard.y, reqCard.w, reqCard.h, reqStart, fEnd)
  add(
    mono('["REQ", "feed", {"kinds":[1]}]', reqCard.x + 20, reqCard.y + 16, 14, { fill: PINK }),
    atF(reqStart + 2, reqCard.y + 16),
  )
  add(
    mono('← ["EVENT", "feed", {…}]\n← ["EOSE", "feed"]\n  live updates stream on', reqCard.x + 20, reqCard.y + 40, 14, {
      fill: BODY,
      lineHeight: 22,
    }),
    atF(reqStart + 4, reqCard.y + 40),
  )

  // Storage
  add(mono('STORAGE', stX, 446, 13, { letterSpacing: 3, fill: MUTED }), atF(f0 + 48, 446))
  const storage = [
    { logo: 'postgresql', name: 'PostgreSQL', sub: 'events · durable store', y: 480, from: core.y + 90 },
    { logo: 'redis', name: 'Redis', sub: 'cache · rate limits', y: 650, from: core.y + 190 },
  ]
  const storageWires: string[] = []
  storage.forEach(({ logo, name, sub, y, from }, i) => {
    const s = f0 + 48 + i * 8
    card(stX, y, stW, 112, s, fEnd)
    add(img(logo, stX + 22, y + 27, 58), atF(s + 2, y + 27))
    add(sans(name, stX + 98, y + 24, 27, { letterSpacing: -0.5 }), atF(s + 2, y + 24))
    add(mono(sub, stX + 98, y + 66, 14, { fill: MUTED }), atF(s + 2, y + 66))
    storageWires.push(curve(core.x + core.w, from, stX, y + 56))
  })

  // Stored-event counter on the PostgreSQL card
  const counts = ['12,480', '12,483', '12,486', '12,489']
  counts.forEach((value, i) => {
    const s = i === 0 ? f0 + 52 : CYCLES[i - 1] + 34
    const e = i === counts.length - 1 ? fEnd : CYCLES[i] + 34
    const x = stX + stW - 20 - monoWidth(value, 15)
    add(
      mono(value, x, 480 + 28, 15, { fill: i === 0 ? MUTED : PINK, fontWeight: 700 }),
      show(508, { start: s, end: e, inF: 4, outF: 4 }),
    )
  })

  // Lightning (top) & deploy (bottom)
  const ln = { x: 790, y: 336, w: 340, h: 104 }
  const lnStart = f0 + 62
  card(ln.x, ln.y, ln.w, ln.h, lnStart, fEnd)
  add(img('lightning', ln.x + 18, ln.y + 30, 44), atF(lnStart + 2, ln.y + 30))
  add(img('bitcoin', ln.x + 68, ln.y + 30, 44), atF(lnStart + 2, ln.y + 30))
  add(sans('Lightning payments', ln.x + 126, ln.y + 24, 20, { letterSpacing: -0.3 }), atF(lnStart + 2, ln.y + 24))
  add(mono('paid admission · zaps', ln.x + 126, ln.y + 58, 14, { fill: MUTED }), atF(lnStart + 2, ln.y + 58))
  const lnWire = curve(core.x + core.w / 2, ln.y + ln.h, core.x + core.w / 2, core.y)

  const dp = { x: 760, y: 846, w: 400, h: 88 }
  const dpStart = f0 + 70
  card(dp.x, dp.y, dp.w, dp.h, dpStart, fEnd)
  add(img('docker', dp.x + 18, dp.y + 22, 44), atF(dpStart + 2, dp.y + 22))
  add(img('torproject', dp.x + 70, dp.y + 22, 44), atF(dpStart + 2, dp.y + 22))
  add(sans('Deploy anywhere', dp.x + 130, dp.y + 16, 20, { letterSpacing: -0.3 }), atF(dpStart + 2, dp.y + 16))
  add(mono('docker compose · --tor · --i2p', dp.x + 130, dp.y + 50, 14, { fill: MUTED }), atF(dpStart + 2, dp.y + 50))
  const dpWire = curve(core.x + core.w / 2, core.y + core.h, core.x + core.w / 2, dp.y)

  clientWires.forEach(({ d }, i) => drawWire(d, f0 + 40 + i * 4, fEnd))
  storageWires.forEach((d, i) => drawWire(d, f0 + 58 + i * 4, fEnd))
  drawWire(lnWire, lnStart + 6, fEnd)
  drawWire(dpWire, dpStart + 6, fEnd)
  drawWire(
    curve(eventCard.x + eventCard.w - 40, eventCard.y + eventCard.h, eventCard.x + eventCard.w - 40, 470),
    evStart + 6,
    fEnd,
    WIRE,
    1.5,
  )
  drawWire(
    curve(reqCard.x + reqCard.w - 40, reqCard.y + reqCard.h, reqCard.x + reqCard.w - 40, 480),
    reqStart + 6,
    fEnd,
    WIRE,
    1.5,
  )

  CYCLES.forEach((t, c) => {
    clientWires.forEach(({ d }, i) => pulse(d, t + i * 4))
    if (c === 0) {
      pulse(lnWire, t + 10, 20)
    }
    storageWires.forEach((d, i) => pulse(d, t + 30 + i * 3, 22))
    clientWires.forEach(({ back }, i) => pulse(back, t + 54 + i * 3, 22))
    glow(core.x + core.w / 2, core.y + core.h / 2 - 40, 780, [[t + 22, t + 50]], 0.6)
  })
  const [c0, c1, c2] = CYCLES
  light('nostr', c0, c0 + 26)
  light('lightning', c0 + 8, c0 + 34)
  light('nostream', c0 + 22, c0 + 50)
  light('postgresql', c1 + 28, c1 + 56)
  light('redis', c1 + 28, c1 + 56)
  light('nostr', c2 + 50, c2 + 80)

  const captions: [string, string, number, number][] = [
    ['01', 'Clients sign & publish EVENTs over WebSocket', c0 - 10, c0 + 24],
    ['02', 'nostream verifies signatures, limits & admission', c0 + 24, c1 + 20],
    ['03', 'Events persist in PostgreSQL — Redis keeps rate limits hot', c1 + 20, c2],
    ['04', 'Matching REQ subscriptions receive them instantly', c2, c2 + 50],
    ['→', 'One relay, many clients — all events under your control', c2 + 50, fEnd],
  ]
  for (const [num, text, s, e] of captions) {
    add(
      mono(num, hx, 966, 16, { fill: PINK, fontWeight: 700 }),
      show(966, { start: s, end: e, dy: 8, inF: 8, outF: 8 }),
    )
    add(mono(text, hx + 46, 966, 16, { fill: FG }), show(966, { start: s, end: e, dy: 8, inF: 8, outF: 8 }))
  }

  // ── Scene 4 · Features ────────────────────────────────────────────────
  const g0 = FEATURES.start
  const gEnd = FEATURES.end
  sceneLabel('03  —  WHY NOSTREAM', 150, g0 + 4, gEnd)
  add(
    sans('Everything a relay operator needs.', hx - 4, 180, 72, { letterSpacing: -2.5, fontWeight: 800 }),
    show(180, { start: g0 + 8, end: gEnd, dy: 28, inF: 18 }),
  )
  add(
    sans("Nothing you don't.", hx - 4, 262, 72, { letterSpacing: -2.5, fontWeight: 800, fill: PINK }),
    show(262, { start: g0 + 16, end: gEnd, dy: 28, inF: 18 }),
  )

  const features: { logos: string[]; rail?: keyof typeof lit; title: string; body: string }[] = [
    {
      logos: ['nostr'],
      rail: 'nostr',
      title: `${NIP_COUNT} NIPs supported`,
      body: 'DMs, reactions, replaceable &\nexpiring events, counts, search',
    },
    {
      logos: ['lightning', 'bitcoin'],
      rail: 'lightning',
      title: 'Paid admission',
      body: 'LNbits, ZEBEDEE, OpenNode,\nNodeless, LNURL or NWC',
    },
    {
      logos: ['redis'],
      rail: 'redis',
      title: 'Rate limits & spam rules',
      body: 'Per-IP and per-pubkey limits,\nproof of work, content filters',
    },
    {
      logos: ['postgresql'],
      rail: 'postgresql',
      title: 'Import & export',
      body: 'Stream events in and out as\n.jsonl or .json, compressed',
    },
    {
      logos: ['torproject'],
      title: 'Tor & I2P built in',
      body: 'Serve your relay over .onion\nor I2P with a single flag',
    },
    {
      logos: [],
      rail: 'nostream',
      title: 'Admin console',
      body: 'Network health, NIP-66 probes\nand live relay settings',
    },
  ]
  const fc = { w: 506, h: 200, gapX: 40, gapY: 34, y: 384 }
  features.forEach(({ logos, rail, title, body }, i) => {
    const col = i % 3
    const row = Math.floor(i / 3)
    const x = hx + col * (fc.w + fc.gapX)
    const y = fc.y + row * (fc.h + fc.gapY)
    const s = g0 + 34 + i * 8
    const at = (yy: number, d = 4) => show(yy, { start: s + d, end: gEnd, dy: 16 })
    card(x, y, fc.w, fc.h, s, gEnd)
    add(
      rect(x + 1, y, 0, 2, { background: PINK }),
      at(y, 2).keys('width', [
        [s + 6, 0],
        [s + 30, fc.w - 2, 'power2.out'],
      ]),
    )
    if (logos.length === 0) {
      add(rect(x + 34, y + 38, 40, 40, { background: PINK, borderRadius: 2 }), at(y + 38))
    }
    logos.forEach((name, j) => add(img(name, x + 28 + j * 34, y + 32 + j * 22, j ? 32 : 52), at(y + 32 + j * 22)))
    add(sans(title, x + 108, y + 36, 28, { letterSpacing: -0.6 }), at(y + 36, 6))
    add(mono(body, x + 108, y + 88, 17, { fill: BODY, lineHeight: 28 }), at(y + 88, 8))
    if (rail) {
      light(rail, s, s + 46)
    }
  })
  const cfgY = fc.y + 2 * fc.h + fc.gapY + 52
  add(mono('→', hx, cfgY, 18, { fill: PINK, fontWeight: 700 }), show(cfgY, { start: g0 + 90, end: gEnd, dy: 10 }))
  add(
    mono('Every option lives in one file:  .nostr/settings.yaml', hx + 36, cfgY, 18, { fill: FG }),
    show(cfgY, { start: g0 + 92, end: gEnd, dy: 10 }),
  )

  // ── Scene 5 · Deploy ───────────────────────────────────────────────────
  const d0 = DEPLOY.start
  sceneLabel('04  —  DEPLOY IN MINUTES', 196, d0 + 4, DURATION)
  add(
    sans('Spin up a relay.', hx - 5, 226, 96, { letterSpacing: -3.5, fontWeight: 800 }),
    show(226, { start: d0 + 8, dy: 30, inF: 18 }),
  )
  add(
    sans('Own your corner of Nostr.', hx - 5, 330, 96, { letterSpacing: -3.5, fontWeight: 800, fill: PINK }),
    show(330, { start: d0 + 16, dy: 30, inF: 18 }),
  )

  tabs(486, d0 + 22, DURATION)
  const term = { y: 524, w: 1000, h: 336 }
  add(
    rect(hx, term.y, term.w, term.h, { background: PANEL, borderColor: PANEL_BORDER, borderWidth: 1, borderRadius: 6 }),
    show(term.y, { start: d0 + 24, dy: 14 }),
  )
  add(mono('$', hx + 28, term.y + 26, 23, { fill: PINK, fontWeight: 700 }), show(term.y + 26, { start: d0 + 30 }))
  const cmd = 'nostream start'
  add(
    mono(cmd, hx + 62, term.y + 26, 23, { fill: FG }),
    show(term.y + 26, { start: d0 + 32, inF: 2 }).typewriter(d0 + 34, d0 + 34 + cmd.length * 2, 'linear'),
  )
  copyButton(hx + term.w - 22, term.y + 22, d0 + 30, DURATION)
  add(rect(hx + 1, term.y + 78, term.w - 2, 1, { background: LINE }), show(term.y + 78, { start: d0 + 30 }))

  const boot: [string, string, string, string][] = [
    ['postgresql', 'nostream-db', 'PostgreSQL ready', BODY],
    ['redis', 'nostream-cache', 'Redis ready', BODY],
    ['docker', 'nostream-migrate', 'migrations applied', BODY],
    ['nostr', 'relay', 'listening on ws://0.0.0.0:8008', PINK],
    ['lightning', 'payments', 'lnbits · lnurl · nwc  (optional)', BODY],
  ]
  boot.forEach(([logo, name, detail, color], i) => {
    const y = term.y + 102 + i * 44
    const s = d0 + 66 + i * 10
    add(img(logo, hx + 28, y - 2, 26), show(y, { start: s, inF: 6 }))
    add(check(hx + 68, y + 5, 14), show(0, { start: s, inF: 6 }))
    add(mono(name, hx + 98, y, 19, { fill: FG }), show(y, { start: s, inF: 6 }))
    add(mono(detail, hx + 340, y, 19, { fill: color }), show(y, { start: s, inF: 6 }))
  })
  light('docker', d0 + 40, d0 + 100)

  const built = [
    'typescript',
    'nodedotjs',
    'postgresql',
    'redis',
    'docker',
    'lightning',
    'bitcoin',
    'torproject',
    'nostr',
  ]
  add(mono('BUILT WITH', hx, 914, 13, { letterSpacing: 3, fill: MUTED }), show(914, { start: d0 + 40 }))
  built.forEach((name, i) => {
    const x = 340 + i * 66
    add(img(`${name}-gray`, x, 902, 36), show(902, { start: d0 + 40 + i * 2, peak: 0.8 }))
    add(img(name, x, 902, 36), show(902, { start: d0 + 112 + i * 4, inF: 10 }))
  })

  // ── Stack rail: 01–06, lit as each part of the stack is explained ─────
  const allOn: Window = [d0 + 112, DURATION]
  add(rect(71, 210, 1, 680, { background: LINE }), show(210, always))
  ;(Object.keys(lit) as (keyof typeof lit)[]).forEach((name, i) => {
    const y = 250 + i * 110
    const windows = [...lit[name], allOn]
    const on = () => LayerAnimation.create().keys('opacity', windowKeys(windows, 1, 8, 10))
    add(rect(58, y - 8, 28, 54, { background: BG }), show(y, always))
    if (name === 'nostream') {
      add(rect(63, y + 3, 20, 20, { background: '#4a4a4a' }), show(y, always))
      add(rect(63, y + 3, 20, 20, { background: PINK }), on())
    } else {
      add(img(`${name}-gray`, 59, y, 27), show(y, { ...always, peak: 0.7 }))
      add(img(name, 59, y, 27), on())
    }
    add(mono(String(i + 1).padStart(2, '0'), 64, y + 32, 11, { fill: MUTED }), show(y, always))
    add(rect(46, y, 3, 27, { background: PINK }), on())
  })

  // ── Finish ─────────────────────────────────────────────────────────────
  film.add(Layer.image(asset('grain'), { position: 'absolute', x: 0, y: 0, width: W, height: H }) as never)
  film.apply(new Vignette({ strength: 0.16, radius: 0.95, softness: 0.7 }))

  return film
}
