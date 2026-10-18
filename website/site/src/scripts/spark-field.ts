/**
 * Silver dot field rising from the pink planet (CTA and deploy sections).
 * The old left-to-right stream mode is gone: the home hero used it and it made
 * the headline unreadable (measured 2026-10-18, Cameri's call).
 */
export function initSparkFields() {
  document.querySelectorAll<HTMLElement>('[data-spark-host]').forEach((section) => {
    const canvas = section.querySelector<HTMLCanvasElement>('[data-spark-canvas]')
    if (!canvas || canvas.dataset.sparksRunning === '1') return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return
    ctx.imageSmoothingEnabled = false

    const maxPool = Number(canvas.dataset.maxPool || 260)
    const spawnChance = Number(canvas.dataset.spawnChance || 0.85)
    const perFrame = Number(canvas.dataset.perFrame || 1)

    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    type P = {
      x: number
      y: number
      vx: number
      vy: number
      life: number
      max: number
      bright: boolean
    }
    const pool: P[] = []

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = section.getBoundingClientRect()
      w = Math.max(1, Math.floor(rect.width))
      h = Math.max(1, Math.floor(rect.height))
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const spawn = () => {
      const spread = w * (section.dataset.sparkSpread ? Number(section.dataset.sparkSpread) : 0.48)
      const yBase = h * (section.dataset.sparkOrigin ? Number(section.dataset.sparkOrigin) : 0.9)
      pool.push({
        x: w * 0.5 + (Math.random() - 0.5) * spread,
        y: yBase + Math.random() * h * 0.08,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -(0.5 + Math.random() * 1.2),
        life: 0,
        max: 80 + Math.random() * 120,
        bright: Math.random() < 0.2,
      })
    }

    const tick = () => {
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'source-over'
      for (let n = 0; n < perFrame; n++) {
        if (pool.length < maxPool && Math.random() < spawnChance) spawn()
      }

      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i]
        p.life++
        p.x += p.vx + Math.sin(p.life * 0.07 + i) * 0.12
        p.y += p.vy
        p.vy -= 0.004

        const t = p.life / p.max
        const alpha = t < 0.08 ? t / 0.08 : t > 0.78 ? (1 - t) / 0.22 : 1

        if (p.bright) {
          ctx.fillStyle = `rgba(255,255,255,${Math.min(1, alpha)})`
        } else {
          const silver = 175 + (i % 5) * 8
          ctx.fillStyle = `rgba(${silver},${silver + 6},${silver + 14},${0.92 * alpha})`
        }

        ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1)

        if (p.life >= p.max || p.y < -20) pool.splice(i, 1)
      }

      raf = requestAnimationFrame(tick)
    }

    canvas.dataset.sparksRunning = '1'
    resize()
    tick()

    const ro = new ResizeObserver(resize)
    ro.observe(section)

    section.addEventListener(
      'spark:dispose',
      () => {
        cancelAnimationFrame(raf)
        ro.disconnect()
        canvas.dataset.sparksRunning = '0'
      },
      { once: true },
    )
  })
}

if (typeof document !== 'undefined') {
  initSparkFields()
  document.addEventListener('astro:page-load', initSparkFields)
  document.addEventListener('astro:before-swap', () => {
    document.querySelectorAll('[data-spark-host]').forEach((el) => el.dispatchEvent(new Event('spark:dispose')))
  })
}
