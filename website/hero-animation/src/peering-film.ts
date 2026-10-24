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
 * Relay peering launch film.
 * Same visual dialect as the 3.3.0 release film (omp.sh palette, dot grid,
 * particle planet, terminal cards): 40 s @ 30 fps =
 * 1200 frames. One job per scene, framed as what peering makes possible.
 *
 * Scene copy doc: docs/peering-film-copy.md (#942). On-screen claims follow the peering plan (#931–#940):
 * - terms are a flat fee for a period the operator sets, never per event
 * - settlement is Lightning between relays, in sats
 * - a cache window is operator-configured; "the last hour" is one such window
 * No named operators, counts, or network statistics.
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

/** Scene boundaries (frames). One idea each, then the inversion over the planet. */
const PEOPLE = { start: 0, end: 240 }
const WORTH = { start: 240, end: 520 }
const FAST = { start: 520, end: 760 }
const MIDDLE = { start: 760, end: 980 }
const CLOSE = { start: 980, end: DURATION_FILM }

const INK = '#08080a'

const rect = (x: number, y: number, w: number, h: number, opts: Record<string, unknown> = {}) =>
  Layer.box({ position: 'absolute', x, y, width: w, height: h, opacity: 0, ...opts })

const img = (name: string, x: number, y: number, size: number) =>
  Layer.image(asset(name), { position: 'absolute', x, y, width: size, height: size, opacity: 0 })


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

const sans = (text: string, x: number, y: number, size: number, opts: Record<string, unknown> = {}) =>
  Layer.text(text, {
    position: 'absolute',
    x,
    y,
    fontFamily: FONT_SANS,
    fontSize: size,
    fontWeight: 700,
    fill: FG,
    letterSpacing: -1.2,
    opacity: 0,
    ...opts,
  })

/** Headline that rises in and fades with its scene, matching the 3.3.0 film. */
function headlineAnim(y: number, start: number, end: number, delay: number) {
  const a = start + delay
  return LayerAnimation.create()
    .keys('opacity', [
      [a, 0],
      [a + 22, 1, 'power2.out'],
      [end - 14, 1],
      [end, 0, 'power2.in'],
    ])
    .fromTo('y', y + 22, y, { start: a, end: a + 28, ease: 'power3.out' })
}

export async function buildFilm(): Promise<Composition> {
  const pending: { node: Node; anim?: LayerAnimation }[] = []
  const add = (node: Node, anim?: LayerAnimation) => pending.push({ node, anim })

  const sceneKicker = (label: string, start: number, end: number, y = 132) => {
    const hx = 168
    add(mono(label, hx, y, 15, { letterSpacing: 3, fill: TEAL }), show(y, { start: start + 4, end, dy: 10, inF: 12 }))
    add(
      rect(hx, y + 26, 72, 1, { background: TEAL }),
      LayerAnimation.create()
        .keys('opacity', windowKeys([[start + 8, end]], 0.9, 10, 10))
        .keys('width', [
          [start + 8, 0],
          [start + 28, 72, 'power2.out'],
          [Math.max(start + 30, end - 12), 72],
          [end, 0],
        ]),
    )
  }

  // ── Backdrop: same stack as the landing hero (grid, planet, halo, grain) ─
  add(
    Layer.image(asset('grid'), { position: 'absolute', x: 0, y: 0, width: W, height: H, opacity: 0 }),
    LayerAnimation.create().keys('opacity', [
      [0, 0],
      [28, 1, 'power2.out'],
      [LAST, 1],
    ]),
  )

  const planetSize = 1700
  const haloSize = planetSize * (2000 / 1600)
  const planetX = 1180
  const planetY: Key[] = [
    [0, 1180],
    [55, 680, 'power3.out'],
    [WORTH.start + 20, 820, 'power2.inOut'],
    [FAST.end - 20, 860],
    [MIDDLE.start + 20, 920, 'power2.inOut'],
    [CLOSE.start + 32, 560, 'power3.out'],
    [LAST, 545],
  ]
  const planetOpacity: Key[] = [
    [0, 0],
    [35, 0.82],
    [WORTH.start + 20, 0.55],
    [FAST.end - 20, 0.48],
    [MIDDLE.end - 20, 0.42],
    [CLOSE.start + 32, 1],
  ]
  add(
    Layer.image(asset('planet'), {
      position: 'absolute',
      x: planetX,
      y: 1180,
      width: planetSize,
      height: planetSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys('y', planetY)
      .keys('opacity', planetOpacity)
      .fromTo('rotation', 0, 48, { start: 0, end: LAST, ease: 'linear' }),
  )
  const haloOffset = (haloSize - planetSize) / 2
  add(
    Layer.image(asset('sparkles'), {
      position: 'absolute',
      x: planetX - haloOffset,
      y: 1180 - haloOffset,
      width: haloSize,
      height: haloSize,
      opacity: 0,
    }),
    LayerAnimation.create()
      .keys('opacity', planetOpacity.map(([f, v, e]) => (e ? [f, (v as number) * 0.85, e] : [f, (v as number) * 0.85]) as Key))
      .keys(
        'y',
        planetY.map(([f, v, e]) => (e ? [f, (v as number) - haloOffset, e] : [f, (v as number) - haloOffset]) as Key),
      )
      .fromTo('rotation', 12, -38, { start: 0, end: LAST, ease: 'linear' }),
  )

  // ── Brand chrome: official mark + wordmark ───────────────────────────────
  add(img('nostream', 118, 38, 26), show(38, { start: 10, inF: 20 }))
  add(mono('nostream', 152, 34, 22, { fill: FG, fontWeight: 700 }), show(34, { start: 10, inF: 20 }))

  const footer = 'OPEN SOURCE  ·  MIT LICENSE  ·  GITHUB.COM/CAMERI/NOSTREAM'
  add(mono(footer, (W - monoWidth(footer, 17)) / 2, 1010, 17, { fill: MUTED }), show(1010, { start: CLOSE.start + 24, inF: 16 }))

  const hx = 168

  // ── Scene 1 · PEOPLE: a relay for your people, not the whole network ───
  {
    const end = PEOPLE.end
    sceneKicker('01  —  YOUR PEOPLE', PEOPLE.start, end)
    add(
      sans('Run a relay for your people.', hx, 196, 72),
      headlineAnim(196, PEOPLE.start, end, 12),
    )
    add(
      sans('Not the whole network.', hx, 292, 44, { fill: PINK, fontWeight: 600, letterSpacing: -0.6 }),
      headlineAnim(292, PEOPLE.start, end, 36),
    )

    const cards = [
      { k: 'SCOPE', t: 'Your people', d: 'not the whole network' },
      { k: 'PEERS FOR', t: 'Its scope', d: 'peers for its scope' },
      { k: 'FETCHES', t: 'The rest', d: 'on demand' },
    ]
    const cardY = 420
    const cardW = 520
    const cardH = 228
    cards.forEach((c, i) => {
      const x = hx + i * (cardW + 36)
      const s = PEOPLE.start + 58 + i * 16
      add(
        Layer.box({
          position: 'absolute',
          x,
          y: cardY,
          width: cardW,
          height: cardH,
          background: PANEL,
          borderColor: i === 1 ? PINK : PANEL_BORDER,
          borderWidth: i === 1 ? 2 : 1,
          borderRadius: 10,
          opacity: 0,
        }),
        show(cardY, { start: s, end, dy: 16 }),
      )
      add(
        Layer.box({ position: 'absolute', x: x + 36, y: cardY + 22, width: 36, height: 4, background: PINK, opacity: 0 }),
        show(cardY + 22, { start: s + 6, end, inF: 8 }),
      )
      add(mono(c.k, x + 36, cardY + 36, 18, { fill: TEAL }), show(cardY + 36, { start: s + 8, end, inF: 10 }))
      add(sans(c.t, x + 36, cardY + 78, 40), show(cardY + 78, { start: s + 12, end, dy: 10, inF: 12 }))
      add(mono(c.d, x + 36, cardY + 148, 22, { fill: FG_2 }), show(cardY + 148, { start: s + 20, end, inF: 12 }))
    })
    add(
      sans('Feel complete without ingesting everything.', hx, 708, 34, { fill: BODY, fontWeight: 500, letterSpacing: -0.4 }),
      headlineAnim(708, PEOPLE.start, end, 118),
    )
  }

  // ── Scene 2 · WORTH: a flat Lightning fee, never per event ──────────────
  {
    const end = WORTH.end
    sceneKicker('02  —  YOUR ARCHIVE', WORTH.start, end)
    add(sans('Your archive', hx, 176, 84), headlineAnim(176, WORTH.start, end, 8))
    add(
      sans('is worth something now.', hx, 274, 84, { fill: PINK }),
      headlineAnim(274, WORTH.start, end, 26),
    )
    add(
      mono('Sell feeds to other relays — settled in sats.', hx, 378, 24, { fill: BODY }),
      headlineAnim(378, WORTH.start, end, 44),
    )

    const panelX = hx
    const panelY = 448
    const panelW = 1584
    const panelH = 340
    add(
      Layer.box({
        position: 'absolute',
        x: panelX,
        y: panelY,
        width: panelW,
        height: panelH,
        background: PANEL,
        borderColor: PANEL_BORDER,
        borderWidth: 1,
        borderRadius: 10,
        opacity: 0,
      }),
      show(panelY, { start: WORTH.start + 48, end, dy: 14 }),
    )
    add(rect(panelX + 44, panelY + 18, 120, 3, { background: PINK }), show(panelY + 18, { start: WORTH.start + 58, end, inF: 10 }))
    add(mono('PEERING TERMS', panelX + 44, panelY + 32, 18, { fill: TEAL }), show(panelY + 32, { start: WORTH.start + 64, end, inF: 10 }))

    const chipW = 248
    const chipH = 52
    const chipX = panelX + panelW - chipW - 28
    const chipY = panelY + 22
    add(
      Layer.box({ position: 'absolute', x: chipX, y: chipY, width: chipW, height: chipH, background: PINK, borderRadius: 26, opacity: 0 }),
      show(chipY, { start: WORTH.start + 150, end, inF: 10 }),
    )
    add(
      mono('PER PERIOD', chipX, chipY + 14, 22, { fill: INK, fontWeight: 700, align: 'center', width: chipW }),
      show(chipY + 14, { start: WORTH.start + 156, end, inF: 10 }),
    )

    const rows = [
      { k: 'fee', v: 'flat — one charge for the period', color: FG },
      { k: 'period', v: 'you set the length', color: FG_2 },
      { k: 'settlement', v: 'Lightning, in sats, between relays', color: FG, icon: true },
      { k: 'per event', v: 'never', color: PINK },
    ]
    rows.forEach((row, i) => {
      const yy = panelY + 96 + i * 56
      const s = WORTH.start + 78 + i * 14
      add(mono(row.k, panelX + 44, yy, 26, { fill: MUTED }), show(yy, { start: s, end, inF: 8 }))
      const vx = panelX + 360
      if (row.icon) {
        add(
          Layer.image(asset('lightning'), { position: 'absolute', x: vx, y: yy - 4, width: 32, height: 32, opacity: 0 }),
          show(yy - 4, { start: s + 6, end, inF: 8 }),
        )
      }
      add(mono(row.v, row.icon ? vx + 44 : vx, yy, 26, { fill: row.color }), show(yy, { start: s + 4, end, inF: 10 }))
    })

    add(
      sans('A product, not a cost center.', hx, 828, 36, { fill: BODY, fontWeight: 500, letterSpacing: -0.4 }),
      headlineAnim(828, WORTH.start, end, 168),
    )
  }

  // ── Scene 3 · FAST: an operator-set cache window, illustrated as an hour ─
  {
    const end = FAST.end
    sceneKicker('03  —  HOT FEED', FAST.start, end)
    add(sans('Fast, everywhere.', hx, 196, 88), headlineAnim(196, FAST.start, end, 8))
    add(
      sans('The hot feed, near the readers.', hx, 308, 42, { fill: BODY, fontWeight: 500, letterSpacing: -0.4 }),
      headlineAnim(308, FAST.start, end, 30),
    )

    const trackX = hx
    const trackY = 470
    const trackW = 1584
    const split = Math.round(trackW * 0.62)
    add(
      Layer.box({ position: 'absolute', x: trackX, y: trackY, width: trackW, height: 16, background: LINE, borderRadius: 8, opacity: 0 }),
      show(trackY, { start: FAST.start + 52, end, inF: 10 }),
    )
    add(
      Layer.box({ position: 'absolute', x: trackX + split, y: trackY, width: trackW - split, height: 16, background: TEAL, borderRadius: 8, opacity: 0 }),
      LayerAnimation.create()
        .keys('opacity', [
          [FAST.start + 70, 0],
          [FAST.start + 82, 1],
          [end - 14, 1],
          [end, 0, 'power2.in'],
        ])
        .fromTo('width', 0, trackW - split, { start: FAST.start + 74, end: FAST.start + 130, ease: 'power2.out' }),
    )
    add(
      Layer.box({ position: 'absolute', x: trackX + split - 2, y: trackY - 14, width: 4, height: 44, background: PINK, borderRadius: 2, opacity: 0 }),
      show(trackY - 14, { start: FAST.start + 88, end, inF: 8 }),
    )

    add(mono('OLDER THAN THE WINDOW', trackX, trackY - 48, 18, { fill: MUTED }), show(trackY - 48, { start: FAST.start + 60, end, inF: 10 }))
    add(mono('THE HOT FEED', trackX + split + 16, trackY - 48, 18, { fill: TEAL }), show(trackY - 48, { start: FAST.start + 78, end, inF: 10 }))

    const notes = [
      { k: 'BEFORE THIS CUT', t: 'Ask an archive.', d: 'outside the window', edge: PANEL_BORDER },
      { k: 'CACHE PEERS', t: 'The last hour.', d: 'operator-configured window', edge: TEAL },
    ]
    const noteY = 548
    const noteW = 760
    notes.forEach((n, i) => {
      const x = trackX + i * (noteW + 64)
      const s = FAST.start + 100 + i * 16
      add(
        Layer.box({
          position: 'absolute',
          x,
          y: noteY,
          width: noteW,
          height: 176,
          background: PANEL,
          borderColor: n.edge,
          borderWidth: n.edge === TEAL ? 2 : 1,
          borderRadius: 10,
          opacity: 0,
        }),
        show(noteY, { start: s, end, dy: 12 }),
      )
      add(mono(n.k, x + 36, noteY + 28, 18, { fill: TEAL }), show(noteY + 28, { start: s + 8, end, inF: 8 }))
      add(sans(n.t, x + 36, noteY + 64, 40), show(noteY + 64, { start: s + 12, end, dy: 8, inF: 12 }))
      add(mono(n.d, x + 36, noteY + 122, 22, { fill: FG_2 }), show(noteY + 122, { start: s + 18, end, inF: 10 }))
    })

    add(
      sans('Small relays feel instant — without owning the firehose.', hx, 800, 34, { fill: BODY, fontWeight: 500, letterSpacing: -0.3 }),
      headlineAnim(800, FAST.start, end, 136),
    )
  }

  // ── Scene 4 · MIDDLE: archives and caches behind user-facing edges ──────
  {
    const end = MIDDLE.end
    sceneKicker('04  —  THE MIDDLE', MIDDLE.start, end)
    add(sans('Relays that only talk to relays.', hx, 188, 64), headlineAnim(188, MIDDLE.start, end, 8))
    add(
      sans('The network can grow a middle.', hx, 274, 40, { fill: PINK, fontWeight: 600, letterSpacing: -0.5 }),
      headlineAnim(274, MIDDLE.start, end, 28),
    )

    const roles = [
      { k: 'ARCHIVE', t: 'Deep history', d: 'backbone infrastructure', accent: false },
      { k: 'CACHE', t: 'Rolling window', d: 'hot feed near readers', accent: false },
      { k: 'EDGE', t: 'Faces users', d: 'edges facing users', accent: true },
    ]
    const cardY = 430
    const cardW = 500
    const cardH = 240
    const gap = 42
    const centers = roles.map((_, i) => hx + i * (cardW + gap) + cardW / 2)
    const lineY = cardY - 36
    add(
      Layer.box({
        position: 'absolute',
        x: centers[0],
        y: lineY,
        width: centers[2] - centers[0],
        height: 2,
        background: WIRE,
        opacity: 0,
      }),
      show(lineY, { start: MIDDLE.start + 48, end, inF: 12 }),
    )
    add(
      Layer.box({ position: 'absolute', x: centers[0], y: lineY - 3, width: 72, height: 8, background: PINK, borderRadius: 4, opacity: 0 }),
      LayerAnimation.create()
        .keys('opacity', [
          [MIDDLE.start + 70, 0],
          [MIDDLE.start + 82, 1],
          [end - 14, 1],
          [end, 0, 'power2.in'],
        ])
        .fromTo('x', centers[0], centers[2] - 72, { start: MIDDLE.start + 78, end: MIDDLE.start + 150, ease: 'power1.inOut' }),
    )

    roles.forEach((c, i) => {
      const x = hx + i * (cardW + gap)
      const s = MIDDLE.start + 56 + i * 16
      add(
        Layer.box({
          position: 'absolute',
          x,
          y: cardY,
          width: cardW,
          height: cardH,
          background: PANEL,
          borderColor: c.accent ? PINK : PANEL_BORDER,
          borderWidth: c.accent ? 2 : 1,
          borderRadius: 10,
          opacity: 0,
        }),
        show(cardY, { start: s, end, dy: 16 }),
      )
      add(
        Layer.box({ position: 'absolute', x: centers[i] - 7, y: lineY - 6, width: 14, height: 14, background: c.accent ? PINK : TEAL, borderRadius: 7, opacity: 0 }),
        show(lineY - 6, { start: s, end, inF: 8 }),
      )
      add(mono(c.k, x + 36, cardY + 40, 18, { fill: TEAL }), show(cardY + 40, { start: s + 8, end, inF: 10 }))
      add(sans(c.t, x + 36, cardY + 84, 40), show(cardY + 84, { start: s + 12, end, dy: 10, inF: 12 }))
      add(mono(c.d, x + 36, cardY + 156, 22, { fill: FG_2 }), show(cardY + 156, { start: s + 20, end, inF: 12 }))
    })

    add(
      sans('Infrastructure behind. Users in front.', hx, 724, 34, { fill: BODY, fontWeight: 500, letterSpacing: -0.3 }),
      headlineAnim(724, MIDDLE.start, end, 120),
    )
  }

  // ── Scene 5 · CLOSE: the inversion, over the planet ─────────────────────
  {
    add(
      mono('Today, every relay tries to be everything.', 0, 268, 26, { width: W, align: 'center', fill: MUTED }),
      show(268, { start: CLOSE.start + 10, dy: 12, inF: 16 }),
    )
    add(
      sans('Each relay gets to be one thing well.', 0, 340, 72, { width: W, height: 96, align: 'center' }),
      LayerAnimation.create()
        .keys('opacity', [
          [CLOSE.start + 24, 0],
          [CLOSE.start + 48, 1, 'power2.out'],
        ])
        .fromTo('y', 362, 340, { start: CLOSE.start + 24, end: CLOSE.start + 52, ease: 'power3.out' }),
    )
    add(
      sans('The network assembles the rest.', 0, 448, 42, { width: W, height: 56, align: 'center', fill: PINK, fontWeight: 600, letterSpacing: -0.4 }),
      show(448, { start: CLOSE.start + 58, dy: 16 }),
    )
    const sign = 'nostream relay peering'
    const mark = 44
    const signSize = 24
    const signW = monoWidth(sign, signSize)
    const lockupW = mark + 14 + signW
    const lockupX = (W - lockupW) / 2
    add(img('nostream', lockupX, 548, mark), show(548, { start: CLOSE.start + 88, inF: 18 }))
    add(mono(sign, lockupX + mark + 14, 560, signSize, { fill: TEAL }), show(560, { start: CLOSE.start + 94, inF: 18 }))
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
  film.add(Layer.image(asset('grain'), { position: 'absolute', x: 0, y: 0, width: W, height: H, opacity: 0.85 }) as never)
  film.apply(new Vignette({ strength: 0.16, radius: 0.95, softness: 0.7 }))
  return film
}
