import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Composition, Layer, LayerAnimation, Vignette } from 'framefields'
import {
  BG,
  BODY,
  FG,
  FONT_MONO,
  FONT_SANS,
  FPS,
  H,
  MUTED,
  PINK,
  TEAL,
  W,
} from './theme.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE_SCREENS = path.join(ROOT, '..', 'site', 'src', 'assets', 'screens')
const SITE_LOGO = path.join(ROOT, '..', 'site', 'src', 'assets', 'logo.png')
const asset = (name: string) => path.join(ROOT, 'assets', 'gen', `${name}.png`)
const screen = (file: string) => path.join(SITE_SCREENS, file)

/**
 * Admin console film.
 * Talk beats use the landing-hero backdrop (dot grid, planet, sparkle halo).
 * Each beat is a short explanation, then that screen full-frame.
 * 35.3 s @ 30 fps.
 */
export const DURATION_ADMIN = 1060

type Node =
  | ReturnType<typeof Layer.box>
  | ReturnType<typeof Layer.text>
  | ReturnType<typeof Layer.image>
  | ReturnType<typeof Layer.shape>
type Key = [number, number] | [number, number, string]
type Window = [number, number]

const LAST = DURATION_ADMIN - 1

const TITLE = { start: 0, end: 100 }
const METRICS_SAY = { start: 100, end: 190 }
const METRICS_SEE = { start: 190, end: 310 }
const SETTINGS_SAY = { start: 310, end: 400 }
const SETTINGS_SEE = { start: 400, end: 520 }
const NIP_SAY = { start: 520, end: 610 }
const NIP_SEE = { start: 610, end: 730 }
const NOTE_SAY = { start: 730, end: 820 }
const NOTE_SEE = { start: 820, end: 940 }
const CLOSE = { start: 940, end: DURATION_ADMIN }

const TALK: Window[] = [
  [TITLE.start, TITLE.end],
  [METRICS_SAY.start, METRICS_SAY.end],
  [SETTINGS_SAY.start, SETTINGS_SAY.end],
  [NIP_SAY.start, NIP_SAY.end],
  [NOTE_SAY.start, NOTE_SAY.end],
  [CLOSE.start, CLOSE.end],
]

const SHOT = {
  metrices: { w: 2046, h: 1434, file: 'metrices.png' },
  nip66: { w: 2102, h: 1294, file: 'nip66.png' },
  settingsEditor: { w: 2046, h: 906, file: 'settings-editor.png' },
  notification: { w: 2366, h: 1476, file: 'notification.png' },
} as const

type ShotKey = keyof typeof SHOT

function mergeWindows(windows: Window[], gap: number): Window[] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0])
  const out: Window[] = []
  for (const w of sorted) {
    const prev = out[out.length - 1]
    if (prev && w[0] <= prev[1] + gap) prev[1] = Math.max(prev[1], w[1])
    else out.push([...w])
  }
  return out
}

function windowKeys(windows: Window[], peak = 1, inF = 14, outF = 14): Key[] {
  const keys: Key[] = []
  let last = -1
  const push = (f: number, v: number, ease?: string) => {
    const frame = Math.max(0, Math.min(LAST, Math.round(f)))
    if (frame <= last) return
    keys.push(ease ? [frame, v, ease] : [frame, v])
    last = frame
  }
  const merged = mergeWindows(windows, inF + outF)
  if (merged[0][0] > 0) push(0, 0)
  for (const [s, e] of merged) {
    push(s, 0)
    push(s + inF, peak, 'power2.out')
    if (e < DURATION_ADMIN) {
      push(e - outF, peak)
      push(e, 0, 'power2.in')
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
}

function show(y: number, { start, end = DURATION_ADMIN, dy = 0, inF = 14, outF = 12 }: Show) {
  const anim = LayerAnimation.create().keys('opacity', windowKeys([[start, end]], 1, inF, outF))
  if (dy) {
    const yk: Key[] = [
      [start, y + dy],
      [Math.min(LAST, start + inF + 8), y, 'power3.out'],
    ]
    if (end < DURATION_ADMIN) {
      yk.push([Math.max(start + inF + 10, end - outF), y])
      yk.push([end, y - dy * 0.45, 'power2.in'])
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
    fontWeight: 800,
    fill: FG,
    letterSpacing: -2,
    opacity: 0,
    ...opts,
  })

/** Entire screenshot, inset so a frame and bloom can sit around it. */
function contain(name: ShotKey, maxW: number, maxH: number) {
  const { w, h } = SHOT[name]
  const s = Math.min(maxW / w, maxH / h)
  const dw = Math.round(w * s)
  const dh = Math.round(h * s)
  return { w: dw, h: dh }
}

const rect = (x: number, y: number, w: number, h: number, opts: Record<string, unknown> = {}) =>
  Layer.box({ position: 'absolute', x, y, width: w, height: h, opacity: 0, ...opts })

export async function buildFilm(): Promise<Composition> {
  const pending: { node: Node; anim?: LayerAnimation }[] = []
  const add = (node: Node, anim?: LayerAnimation) => pending.push({ node, anim })

  const hx = 160

  // ── Same backdrop as the landing hero ────────────────────────────────────
  add(
    Layer.image(asset('grid'), { position: 'absolute', x: 0, y: 0, width: W, height: H, opacity: 0 }),
    LayerAnimation.create().keys('opacity', windowKeys(TALK, 1, 16, 12)),
  )

  const planetSize = 1700
  const haloSize = planetSize * (2000 / 1600)
  const planetX = 1000
  const planetY: Key[] = [
    [0, 1100],
    [48, 520, 'power3.out'],
    [LAST, 500],
  ]
  add(
    Layer.image(asset('planet'), {
      position: 'absolute',
      x: planetX,
      y: 1100,
      width: planetSize,
      height: planetSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys('y', planetY)
      .keys('opacity', windowKeys(TALK, 1, 16, 12))
      .fromTo('rotation', 0, 42, { start: 0, end: LAST, ease: 'linear' }),
  )
  const haloOffset = (haloSize - planetSize) / 2
  add(
    Layer.image(asset('sparkles'), {
      position: 'absolute',
      x: planetX - haloOffset,
      y: 1100 - haloOffset,
      width: haloSize,
      height: haloSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys(
        'y',
        planetY.map(([f, v, e]) => (e ? [f, (v as number) - haloOffset, e] : [f, (v as number) - haloOffset]) as Key),
      )
      .keys('opacity', windowKeys(TALK, 1, 16, 12))
      .fromTo('rotation', 8, -28, { start: 0, end: LAST, ease: 'linear' }),
  )

  add(
    Layer.image(SITE_LOGO, { position: 'absolute', x: 118, y: 41, width: 24, height: 24, opacity: 0 }),
    LayerAnimation.create().keys('opacity', windowKeys(TALK, 1, 12, 10)),
  )
  add(
    mono('nostream', 150, 37, 22, { fill: FG, fontWeight: 700 }),
    LayerAnimation.create().keys('opacity', windowKeys(TALK, 1, 12, 10)),
  )

  const explain = (kicker: string, head: string, accent: string, body: string, win: { start: number; end: number }) => {
    add(mono(kicker, hx, 250, 15, { letterSpacing: 3, fill: TEAL }), show(250, { start: win.start + 4, end: win.end, dy: 10 }))
    add(
      rect(hx, 276, 64, 1, { background: TEAL }),
      LayerAnimation.create()
        .keys('opacity', windowKeys([[win.start + 8, win.end]], 0.85, 10, 10))
        .keys('width', [
          [win.start + 8, 0],
          [win.start + 28, 64, 'power2.out'],
          [Math.max(win.start + 30, win.end - 12), 64],
          [win.end, 0],
        ]),
    )
    add(sans(head, hx, 300, 78), show(300, { start: win.start + 10, end: win.end, dy: 28, inF: 16 }))
    add(sans(accent, hx, 388, 78, { fill: PINK }), show(388, { start: win.start + 20, end: win.end, dy: 24, inF: 16 }))
    add(mono(body, hx, 500, 22, { fill: BODY }), show(500, { start: win.start + 36, end: win.end, dy: 12 }))
  }

  /**
   * Screenshot and its hairline share one box. The rule is a dim 1px edge,
   * not a bright stroke that can drift off the bitmap.
   */
  const fullShot = (name: ShotKey, label: string, win: { start: number; end: number }) => {
    const stroke = 1
    const marginX = 72
    const marginY = 64
    const inner = contain(name, W - marginX * 2, H - marginY * 2 - 28)
    const x = Math.round((W - inner.w) / 2)
    const y = Math.round((H - inner.h) / 2 - 8)
    const fade = () => LayerAnimation.create().keys('opacity', windowKeys([[win.start, win.end]], 1, 14, 12))

    add(
      rect(x - stroke, y - stroke, inner.w + stroke * 2, inner.h + stroke * 2, {
        background: BG,
        borderColor: '#6e6e78',
        borderWidth: stroke,
      }),
      LayerAnimation.create().keys('opacity', windowKeys([[win.start, win.end]], 0.85, 14, 12)),
    )

    add(
      Layer.image(screen(SHOT[name].file), {
        position: 'absolute',
        x,
        y,
        width: inner.w,
        height: inner.h,
        opacity: 0,
      }),
      fade(),
    )

    add(
      mono(label, 0, y + inner.h + 16, 14, { fill: MUTED, letterSpacing: 3, width: W, align: 'center' }),
      show(y + inner.h + 16, { start: win.start + 16, end: win.end, dy: 8, inF: 12, outF: 10 }),
    )
  }

  // ── Open ─────────────────────────────────────────────────────────────────
  add(
    sans('Operator', 0, 380, 96, { width: W, align: 'center', letterSpacing: -3 }),
    show(380, { start: 12, end: TITLE.end, dy: 28, inF: 18 }),
  )
  add(
    sans('Console', 0, 484, 96, { width: W, align: 'center', letterSpacing: -3, fill: PINK }),
    show(484, { start: 24, end: TITLE.end, dy: 24, inF: 18 }),
  )
  add(
    mono('Know what your relay is actually doing.', 0, 610, 24, { fill: MUTED, width: W, align: 'center' }),
    show(610, { start: 48, end: TITLE.end, dy: 12 }),
  )

  // ── Metrics ──────────────────────────────────────────────────────────────
  explain(
    'LIVE METRICS',
    'Watch the load',
    'as it happens.',
    'Events, rejections, connections, CPU and memory — over SSE.',
    METRICS_SAY,
  )
  fullShot('metrices', '/ADMIN   ·   LIVE METRICS', METRICS_SEE)

  // ── Settings ─────────────────────────────────────────────────────────────
  explain(
    'SETTINGS',
    'Change it.',
    'Undo it.',
    'Validated edits, automatic backups, one-click restore.',
    SETTINGS_SAY,
  )
  fullShot('settingsEditor', '/ADMIN   ·   SETTINGS', SETTINGS_SEE)

  // ── NIP-66 ───────────────────────────────────────────────────────────────
  explain(
    'NIP-66',
    'Reachable from',
    'the outside.',
    'DNS, TLS, WebSocket RTT and NIP-11 — probed per target.',
    NIP_SAY,
  )
  fullShot('nip66', '/ADMIN   ·   NIP-66', NIP_SEE)

  // ── Notifications ────────────────────────────────────────────────────────
  explain(
    'ALERTS',
    'Hear about trouble',
    'first.',
    'Outbound webhooks, and a log of every delivery.',
    NOTE_SAY,
  )
  fullShot('notification', '/ADMIN   ·   ALERTS', NOTE_SEE)

  // ── Close, back on the hero backdrop ─────────────────────────────────────
  add(
    sans('Built into nostream.', 0, 430, 72, { width: W, align: 'center', letterSpacing: -2 }),
    show(430, { start: CLOSE.start + 16, dy: 22, inF: 18 }),
  )
  add(
    mono('nostream start   →   /admin', 0, 540, 26, { fill: TEAL, width: W, align: 'center' }),
    show(540, { start: CLOSE.start + 40, dy: 12, inF: 16 }),
  )

  const film = new Composition({
    width: W,
    height: H,
    fps: FPS,
    durationFrames: DURATION_ADMIN,
    backgroundColor: BG,
    fonts: [path.join(ROOT, 'assets/fonts/JetBrainsMono.ttf'), path.join(ROOT, 'assets/fonts/Inter.ttf')],
  })
  for (const { node, anim } of pending) film.add((anim ? node.animate(anim) : node) as never)
  film.add(
    Layer.image(asset('grain'), { position: 'absolute', x: 0, y: 0, width: W, height: H, opacity: 0 }).animate(
      LayerAnimation.create().keys('opacity', windowKeys(TALK, 0.85, 12, 10)),
    ) as never,
  )
  film.apply(new Vignette({ strength: 0.16, radius: 0.95, softness: 0.7 }))
  return film
}
