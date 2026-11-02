(() => {
  const prefersReduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const start = (host) => {
    const canvas = host.querySelector('[data-spark-canvas]')
    if (!canvas || canvas.dataset.sparksRunning === '1' || prefersReduce()) {
      return
    }

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) {
      return
    }
    ctx.imageSmoothingEnabled = false

    const maxPool = Number(canvas.dataset.maxPool || 1800)
    const spawnChance = Number(canvas.dataset.spawnChance || 0.99)
    const perFrame = Number(canvas.dataset.perFrame || 6)

    let w = 0
    let h = 0
    let dpr = 1
    let raf = 0
    const pool = []

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = Math.max(1, window.innerWidth)
      h = Math.max(1, window.innerHeight)
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const leftStrip = () => Math.min(96, w * 0.12)

    const spawnStream = (edge = false) => {
      const band = (Math.random() + Math.random() + Math.random()) / 3
      const speed = edge ? 0.28 + Math.random() * 1.05 : 0.95 + Math.random() * 2.6
      const strip = leftStrip()
      pool.push({
        x: edge ? Math.random() * strip : -4 - Math.random() * 16,
        y: h * (0.04 + band * 0.92),
        vx: speed,
        vy: (Math.random() - 0.5) * (edge ? 0.1 : 0.16),
        life: 0,
        max: edge ? 160 + Math.random() * 240 : (w * (0.55 + Math.random() * 0.5)) / speed,
        phase: Math.random() * Math.PI * 2,
        bright: Math.random() < (edge ? 0.7 : 0.52),
      })
    }

    const tick = () => {
      ctx.clearRect(0, 0, w, h)
      for (let n = 0; n < perFrame; n++) {
        if (pool.length < maxPool && Math.random() < spawnChance) {
          spawnStream(Math.random() < 0.62)
        }
      }
      if (pool.length < maxPool) {
        if (Math.random() < 0.85) {
          spawnStream(false)
        }
        for (let k = 0; k < 5; k++) {
          if (pool.length < maxPool && Math.random() < 0.8) {
            spawnStream(true)
          }
        }
      }

      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i]
        p.life++
        p.x += p.vx
        p.y += p.vy + Math.sin(p.life * 0.04 + p.phase) * 0.22

        const t = p.life / p.max
        let alpha = t < 0.08 ? t / 0.08 : t > 0.78 ? (1 - t) / 0.22 : 1
        alpha *= 0.7 + 0.45 * Math.abs(Math.sin(p.life * 0.13 + p.phase))
        if (p.x < leftStrip()) {
          alpha = Math.min(1, alpha * 1.25)
        }

        if (p.bright) {
          ctx.fillStyle = `rgba(255,255,255,${Math.min(1, alpha)})`
        } else {
          const s = 246 + (i % 5)
          ctx.fillStyle = `rgba(${s},${s + 1},255,${Math.min(1, alpha * 0.98)})`
        }

        ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1)

        if (p.life >= p.max || p.y < -20 || p.x > w + 10) {
          pool.splice(i, 1)
        }
      }

      raf = requestAnimationFrame(tick)
    }

    canvas.dataset.sparksRunning = '1'
    resize()
    tick()

    const onResize = () => resize()
    window.addEventListener('resize', onResize)

    const stop = () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      pool.length = 0
      ctx.clearRect(0, 0, w, h)
      canvas.dataset.sparksRunning = '0'
    }

    host.addEventListener('spark:dispose', stop, { once: true })
  }

  window.startAdminSparks = () => {
    const host = document.querySelector('[data-spark-host]')
    if (!host) {
      return
    }
    host.classList.remove('sparks-off')
    start(host)
  }

  window.stopAdminSparks = () => {
    const host = document.querySelector('[data-spark-host]')
    if (!host) {
      return
    }
    host.classList.add('sparks-off')
    host.dispatchEvent(new Event('spark:dispose'))
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.startAdminSparks, { once: true })
  } else {
    window.startAdminSparks()
  }
})()
