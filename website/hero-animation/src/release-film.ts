import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Composition, Layer, LayerAnimation, Vignette } from 'framefields'
import {
  BG,
  BODY,
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
  TEAL,
  W,
  WIRE,
} from './theme.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const asset = (name: string) => path.join(ROOT, 'assets', 'gen', `${name}.png`)

/**
 * nostream 3.3.0 — job-to-be-done release film.
 * Same visual dialect as the website hero (omp.sh palette, dot grid, particle
 * planet, terminal strips, numbered section rail), operator-focused story.
 * 40 s @ 30 fps = 1200 frames.
 */
export const DURATION_FILM = 1200

type Node =
  | ReturnType<typeof Layer.box>
  | ReturnType<typeof Layer.text>
  | ReturnType<typeof Layer.image>
  | ReturnType<typeof Layer.shape>
type Key = [number, number] | [number, number, string]
type Window = [number, number]

const LAST = DURATION_FILM - 1

/** Scene boundaries (frames) */
const PROBLEM = { start: 0, end: 150 } // cold open: relay is slow, users feel it
const WAIT = { start: 150, end: 540 } // the throttled client: OK carries the wait
const DOCS = { start: 540, end: 760 } // the operator at 3am: NIP-11 vs reality
const CLOSE = { start: 760, end: DURATION_FILM } // close over the planet

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
    if (e < DURATION_FILM) {
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
  peak?: number
}

function show(y: number, { start, end = DURATION_FILM, dy = 0, inF = 14, outF = 14, peak = 1 }: Show) {
  const anim = LayerAnimation.create().keys('opacity', windowKeys([[start, end]], peak, inF, outF))
  if (dy) {
    const yk: Key[] = [
      [start, y + dy],
      [start + inF + 8, y, 'power3.out'],
    ]
    if (end < DURATION_FILM) {
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

const headline = (parts: { text: string; color: string }[], x: number, y: number, size: number) => {
  const total = parts.reduce((n, p) => n + monoWidth(p.text, size * 1.08), 0)
  let cx = x + (W - x * 2 - total) / 2 > x ? x : x
  return parts.map((p) => {
    const t = Layer.text(p.text, {
      position: 'absolute',
      x: cx,
      y,
      fontFamily: FONT_SANS,
      fontSize: size,
      fontWeight: 700,
      fill: p.color,
      opacity: 0,
    })
    cx += monoWidth(p.text, size * 1.08)
    return t
  })
}

export async function buildFilm(): Promise<Composition> {
  const pending: { node: Node; anim?: LayerAnimation }[] = []
  const add = (node: Node, anim?: LayerAnimation) => pending.push({ node, anim })

  // ── Backdrop: dot grid + particle planet, dimmer than the hero ──────────
  add(Layer.image(asset('grid'), { position: 'absolute', x: 0, y: 0, width: W, height: H, opacity: 0.55 }))

  const planetSize = 1900
  const haloSize = planetSize * (2000 / 1600)
  const planetY: Key[] = [
    [0, 1150],
    [50, 760, 'power3.out'],
    [PROBLEM.end, 745],
    [WAIT.start + 20, 880, 'power2.inOut'],
    [DOCS.end - 20, 900],
    [CLOSE.start + 30, 560, 'power3.out'],
    [LAST, 545],
  ]
  const planetOpacity: Key[] = [
    [0, 0],
    [40, 0.75],
    [PROBLEM.end, 0.75],
    [WAIT.start + 20, 0.4],
    [DOCS.end - 20, 0.4],
    [CLOSE.start + 30, 1],
  ]
  add(
    Layer.image(asset('planet'), {
      position: 'absolute',
      x: 1010,
      y: 1150,
      width: planetSize,
      height: planetSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys('y', planetY)
      .keys('opacity', planetOpacity)
      .fromTo('rotation', 0, 18, { start: 0, end: LAST, ease: 'linear' }),
  )
  const haloOffset = (haloSize - planetSize) / 2
  add(
    Layer.image(asset('sparkles'), {
      position: 'absolute',
      x: 1010 - haloOffset,
      y: 1150 - haloOffset,
      width: haloSize,
      height: haloSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys('opacity', planetOpacity.map(([f, v, e]) => (e ? [f, (v as number) * 0.8, e] : [f, (v as number) * 0.8]) as Key))
      .keys(
        'y',
        planetY.map(([f, v, e]) => (e ? [f, (v as number) - haloOffset, e] : [f, (v as number) - haloOffset]) as Key),
      )
      .fromTo('rotation', 30, -20, { start: 0, end: LAST, ease: 'linear' }),
  )

  // ── Brand chrome: logo top-left, section rail, footer strip ────────────
  add(mono('nostream', 130, 36, 22, { fill: FG_2 }), show(36, { start: 10, inF: 20 }))
  add(Layer.box({ position: 'absolute', x: 106, y: 40, width: 14, height: 14, background: PINK, opacity: 0 }), show(40, { start: 8, inF: 20 }))

  const rail = [
    { n: '01', label: 'problem', win: PROBLEM },
    { n: '02', label: 'wait', win: WAIT },
    { n: '03', label: 'truth', win: DOCS },
    { n: '04', label: '3.3.0', win: CLOSE },
  ]
  for (const r of rail) {
    const ry = 240 + rail.indexOf(r) * 96
    add(
      mono(r.n, 60, ry, 20, { fill: MUTED }),
      show(ry, { start: r.win.start + 6, end: r.win.end, inF: 10, outF: 10 }),
    )
    add(
      Layer.box({ position: 'absolute', x: 82, y: ry + 8, width: 26, height: 4, background: PINK, opacity: 0 }),
      show(ry + 8, { start: r.win.start + 6, end: r.win.end, inF: 10, outF: 10 }),
    )
    add(
      mono(r.label.toUpperCase(), 60, ry + 28, 15, { fill: TEAL }),
      show(ry + 28, { start: r.win.start + 14, end: r.win.end, inF: 10, outF: 10 }),
    )
  }
  add(
    mono('OPEN SOURCE  ·  MIT LICENSE  ·  GITHUB.COM/CAMERI/NOSTREAM', 705, 1010, 17, { fill: MUTED }),
    show(1010, { start: CLOSE.start + 20, inF: 16 }),
  )

  // ── Scene 1 · PROBLEM: "Your relay is slow." ────────────────────────────
  {
    const hy = 380
    const t = Layer.text('Your relay says no.', {
      position: 'absolute',
      x: 130,
      y: hy,
      fontFamily: FONT_SANS,
      fontSize: 88,
      fontWeight: 700,
      fill: FG,
      opacity: 0,
    })
    add(t, LayerAnimation.create().keys('opacity', [[PROBLEM.start + 12, 0], [PROBLEM.start + 34, 1, 'power2.out'], [PROBLEM.end - 14, 1], [PROBLEM.end, 0, 'power2.in']]).fromTo('y', hy + 26, hy, { start: PROBLEM.start + 12, end: PROBLEM.start + 40, ease: 'power3.out' }))
    add(
      Layer.text("It won't say when.", {
        position: 'absolute',
        x: 130,
        y: hy + 130,
        fontFamily: FONT_SANS,
        fontSize: 44,
        fill: BODY,
        opacity: 0,
      }),
      show(hy + 130, { start: PROBLEM.start + 55, end: PROBLEM.end, dy: 18, inF: 12 }),
    )
    // a failing client strip: retries stacking up, rejected
    const stripX = 1110
    const stripY = 300
    add(
      Layer.box({ position: 'absolute', x: stripX, y: stripY, width: 700, height: 420, background: '#121218', borderColor: '#6a6a73', borderWidth: 1.5, borderRadius: 10, opacity: 0 }),
      show(stripY, { start: PROBLEM.start + 30, end: PROBLEM.end, dy: 14 }),
    )
    const attempts = ['EVENT  a3f1…c9d2', 'EVENT  a3f1…c9d2', 'EVENT  a3f1…c9d2']
    attempts.forEach((a, i) => {
      const yy = stripY + 60 + i * 74
      add(
        mono(a, stripX + 40, yy, 24, { fill: FG_2 }),
        show(yy, { start: PROBLEM.start + 50 + i * 26, end: PROBLEM.end, inF: 8 }),
      )
      add(
        mono('… rate-limited', 1560, yy, 24, { fill: PINK }),
        show(yy, { start: PROBLEM.start + 62 + i * 26, end: PROBLEM.end, inF: 8 }),
      )
    })
    add(
      mono('so the client guesses — and keeps hammering', stripX + 40, stripY + 330, 20, { fill: MUTED }),
      show(stripY + 330, { start: PROBLEM.start + 116, end: PROBLEM.end, inF: 12 }),
    )
  }

  // ── Scene 2 · WAIT: the OK message carries the wait ─────────────────────
  {
    const ty = 210
    const line1 = Layer.text('Now the relay answers', {
      position: 'absolute', x: 130, y: ty, fontFamily: FONT_SANS, fontSize: 84, fontWeight: 700, fill: FG, opacity: 0,
    })
    const line2 = Layer.text('with a number.', {
      position: 'absolute', x: 130, y: ty + 96, fontFamily: FONT_SANS, fontSize: 84, fontWeight: 700, fill: PINK, opacity: 0,
    })
    add(line1, LayerAnimation.create().keys('opacity', [[WAIT.start + 8, 0], [WAIT.start + 30, 1, 'power2.out'], [WAIT.end - 14, 1], [WAIT.end, 0, 'power2.in']]).fromTo('y', ty + 22, ty, { start: WAIT.start + 8, end: WAIT.start + 36, ease: 'power3.out' }))
    add(line2, LayerAnimation.create().keys('opacity', [[WAIT.start + 26, 0], [WAIT.start + 48, 1, 'power2.out'], [WAIT.end - 14, 1], [WAIT.end, 0, 'power2.in']]).fromTo('y', ty + 118, ty + 96, { start: WAIT.start + 26, end: WAIT.start + 54, ease: 'power3.out' }))

    // the OK wire message, typed on
    const okY = 520
    add(
      Layer.box({ position: 'absolute', x: 130, y: okY, width: 1100, height: 96, background: PANEL, borderColor: WIRE, borderWidth: 1, borderRadius: 8, opacity: 0 }),
      show(okY, { start: WAIT.start + 40, end: WAIT.end, dy: 10 }),
    )
    const okFull = 'OK — not accepted. Retry in 30 seconds.'
    add(
      mono(okFull, 165, okY + 30, 26, { fill: FG }),
      show(okY + 30, { start: WAIT.start + 55, end: WAIT.end, inF: 22 }),
    )

    // the param highlighted
    add(
      mono('^^ the client now KNOWS: retry after 30 s', 746, okY + 120, 22, { fill: TEAL }),
      show(okY + 120, { start: WAIT.start + 115, end: WAIT.end, dy: 10 }),
    )

    // retry clock: a bar filling, then the event lands
    const clockY = 700
    add(
      mono('retry clock', 130, clockY, 20, { fill: MUTED }),
      show(clockY, { start: WAIT.start + 130, end: WAIT.end, inF: 10 }),
    )
    add(
      Layer.box({ position: 'absolute', x: 130, y: clockY + 40, width: 640, height: 10, background: LINE, borderRadius: 5, opacity: 0 }),
      show(clockY + 40, { start: WAIT.start + 135, end: WAIT.end, inF: 8 }),
    )
    add(
      Layer.box({ position: 'absolute', x: 130, y: clockY + 40, width: 640, height: 10, background: TEAL, borderRadius: 5, opacity: 0 }),
      LayerAnimation.create()
        .keys('opacity', [[WAIT.start + 145, 0], [WAIT.start + 155, 1], [WAIT.end - 14, 1], [WAIT.end, 0, 'power2.in']])
        .fromTo('width', 0, 640, { start: WAIT.start + 150, end: WAIT.start + 285, ease: 'linear' }),
    )
    add(
      mono('EVENT  a3f1…c9d2', 130, clockY + 90, 26, { fill: FG }),
      show(clockY + 90, { start: WAIT.start + 292, end: WAIT.end, inF: 8 }),
    )
    add(
      mono('ACCEPTED', 480, clockY + 90, 24, { fill: TEAL }),
      show(clockY + 90, { start: WAIT.start + 310, end: WAIT.end, inF: 8 }),
    )
    add(
      Layer.text('Clients stop hammering. Events stop being lost.', {
        position: 'absolute', x: 130, y: clockY + 170, fontFamily: FONT_SANS, fontSize: 40, fill: BODY, opacity: 0,
      }),
      show(clockY + 170, { start: WAIT.start + 330, end: WAIT.end, dy: 16 }),
    )
  }

  // ── Scene 3 · DOCS: NIP-11 vs reality ───────────────────────────────────
  {
    const ty = 210
    add(
      Layer.text('Your docs promise one thing.', {
        position: 'absolute', x: 130, y: ty, fontFamily: FONT_SANS, fontSize: 76, fontWeight: 700, fill: FG, opacity: 0,
      }),
      LayerAnimation.create().keys('opacity', [[DOCS.start + 8, 0], [DOCS.start + 30, 1, 'power2.out'], [DOCS.end - 14, 1], [DOCS.end, 0, 'power2.in']]).fromTo('y', ty + 20, ty, { start: DOCS.start + 8, end: DOCS.start + 36, ease: 'power3.out' }),
    )
    add(
      Layer.text('Your relay does another.', {
        position: 'absolute', x: 130, y: ty + 92, fontFamily: FONT_SANS, fontSize: 76, fontWeight: 700, fill: FG_2, opacity: 0,
      }),
      LayerAnimation.create().keys('opacity', [[DOCS.start + 28, 0], [DOCS.start + 50, 1, 'power2.out'], [DOCS.end - 14, 1], [DOCS.end, 0, 'power2.in']]).fromTo('y', ty + 112, ty + 92, { start: DOCS.start + 28, end: DOCS.start + 56, ease: 'power3.out' }),
    )

    const panelY = 470
    const panelW = 760
    // NIP-11 doc panel
    add(
      Layer.box({ position: 'absolute', x: 135, y: panelY, width: panelW, height: 300, background: '#121218', borderColor: '#6a6a73', borderWidth: 1.5, borderRadius: 10, opacity: 0 }),
      show(panelY, { start: DOCS.start + 50, end: DOCS.end, dy: 12 }),
    )
    add(mono('NIP-11 DOCUMENT', 175, panelY + 36, 20, { fill: TEAL }), show(panelY + 36, { start: DOCS.start + 70, end: DOCS.end, inF: 8 }))
    add(mono('rate limit: 100', 175, panelY + 90, 26, { fill: FG_2 }), show(panelY + 90, { start: DOCS.start + 80, end: DOCS.end, inF: 8 }))
    add(mono('accounts needed: no', 175, panelY + 135, 26, { fill: FG_2 }), show(panelY + 135, { start: DOCS.start + 90, end: DOCS.end, inF: 8 }))

    // measured panel
    add(
      Layer.box({ position: 'absolute', x: 1025, y: panelY, width: panelW, height: 300, background: '#121218', borderColor: '#6a6a73', borderWidth: 1.5, borderRadius: 10, opacity: 0 }),
      show(panelY, { start: DOCS.start + 90, end: DOCS.end, dy: 12 }),
    )
    add(mono('MEASURED (probes)', 1065, panelY + 36, 20, { fill: TEAL }), show(panelY + 36, { start: DOCS.start + 110, end: DOCS.end, inF: 8 }))
    add(mono('rate limit: 100', 1065, panelY + 90, 26, { fill: FG_2 }), show(panelY + 90, { start: DOCS.start + 120, end: DOCS.end, inF: 8 }))
    add(mono('accounts needed: YES', 1065, panelY + 135, 26, { fill: PINK }), show(panelY + 135, { start: DOCS.start + 130, end: DOCS.end, inF: 8 }))

    // mismatch chip
    add(
      Layer.box({ position: 'absolute', x: 850, y: panelY - 45, width: 220, height: 64, background: PINK, borderRadius: 36, opacity: 0 }),
      LayerAnimation.create()
        .keys('opacity', [[DOCS.start + 150, 0], [DOCS.start + 165, 1, 'power2.out'], [DOCS.end - 14, 1], [DOCS.end, 0, 'power2.in']])
        .fromTo('scale', 0.6, 1, { start: DOCS.start + 150, end: DOCS.start + 175, ease: 'back.out' }),
    )
    add(
      Layer.text('MISMATCH', {
        position: 'absolute', x: 850, y: panelY - 23, width: 220, height: 36, fontFamily: FONT_MONO, fontSize: 28, fontWeight: 700, fill: '#08080a', align: 'center', opacity: 0,
      }),
      show(panelY + 132, { start: DOCS.start + 158, end: DOCS.end, inF: 8 }),
    )

    add(
      Layer.text('The dashboard flags the drift — before someone posts about it.', {
        position: 'absolute', x: 130, y: 880, fontFamily: FONT_SANS, fontSize: 38, fill: BODY, opacity: 0,
      }),
      show(880, { start: DOCS.start + 165, end: DOCS.end, dy: 16 }),
    )
  }

  // ── Scene 4 · CLOSE: 3.3.0 over the planet ──────────────────────────────
  {
    add(
      Layer.text('nostream 3.3.0', {
        position: 'absolute', x: 0, y: 380, width: W, height: 120, fontFamily: FONT_SANS, fontSize: 112, fontWeight: 700, fill: FG, align: 'center', opacity: 0,
      }),
      LayerAnimation.create().keys('opacity', [[CLOSE.start + 10, 0], [CLOSE.start + 40, 1, 'power2.out']]).fromTo('y', 400, 380, { start: CLOSE.start + 10, end: CLOSE.start + 45, ease: 'power3.out' }),
    )
    add(
      Layer.text('Less friction for your users. Fewer surprises for you.', {
        position: 'absolute', x: 0, y: 530, width: W, height: 60, fontFamily: FONT_SANS, fontSize: 46, fill: BODY, align: 'center', opacity: 0,
      }),
      show(530, { start: CLOSE.start + 55, dy: 18 }),
    )
    add(
      mono('$ nostream start', 816, 660, 30, { fill: TEAL }),
      show(660, { start: CLOSE.start + 85, inF: 26 }),
    )
  }

  const film = new Composition({
    width: W,
    height: H,
    fps: FPS,
    durationMs: (DURATION_FILM / FPS) * 1000,
    backgroundColor: BG,
    fonts: [path.join(ROOT, 'assets/fonts/JetBrainsMono.ttf'), path.join(ROOT, 'assets/fonts/Inter.ttf')],
  })
  for (const { node, anim } of pending) film.add((anim ? node.animate(anim) : node) as never)
  film.apply(new Vignette({ strength: 0.16, radius: 0.95, softness: 0.7 }))
  return film
}
