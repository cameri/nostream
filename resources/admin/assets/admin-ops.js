(() => {
  const config = window.__ADMIN_DASHBOARD__ || { pathPrefix: '' }
  const adminBase = `${config.pathPrefix || ''}/admin`

  const mirrorsBody = document.getElementById('ops-mirrors-body')
  if (!mirrorsBody) {
    return
  }

  const elements = {
    mirrorsSync: document.getElementById('ops-mirrors-sync'),
    mirrorsBody,
    workersSync: document.getElementById('ops-workers-sync'),
    workersBody: document.getElementById('ops-workers-body'),
    nip05Error: document.getElementById('ops-nip05-error'),
    nip05Domain: document.getElementById('ops-nip05-domain'),
    nip05Verified: document.getElementById('ops-nip05-verified'),
    nip05Stale: document.getElementById('ops-nip05-stale'),
    nip05MinFailures: document.getElementById('ops-nip05-min-failures'),
    nip05Refresh: document.getElementById('ops-nip05-refresh'),
    nip05Body: document.getElementById('ops-nip05-body'),
    nip05Pagination: document.getElementById('ops-nip05-pagination'),
    storageKinds: document.getElementById('ops-storage-kinds'),
    storageSince: document.getElementById('ops-storage-since'),
    storageUntil: document.getElementById('ops-storage-until'),
    storageRun: document.getElementById('ops-storage-run'),
    storageError: document.getElementById('ops-storage-error'),
    storageBody: document.getElementById('ops-storage-body'),
  }

  let pollTimer
  let nip05Offset = 0
  const nip05Limit = 50

  const formatTime = (iso) => {
    if (!iso) {
      return '—'
    }
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) {
      return iso
    }
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  }

  const shortPubkey = (pubkey) => (pubkey.length > 16 ? `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}` : pubkey)

  const escapeHtml = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')

  const escapeAttr = (value) => escapeHtml(value).replaceAll('`', '&#96;')

  const signalBadge = (stale) => {
    if (stale) {
      return '<span class="status-badge status-degraded"><span class="status-led" aria-hidden="true"></span>Stale</span>'
    }
    return '<span class="status-badge status-ok"><span class="status-led" aria-hidden="true"></span>Live</span>'
  }

  const workerSignalBadge = (worker) => {
    if (worker.monitored === false) {
      return '<span class="status-badge"><span class="status-led" aria-hidden="true"></span>Unmonitored</span>'
    }
    return signalBadge(worker.stale)
  }

  const adminFetch = async (path, options = {}) => {
    const response = await fetch(`${adminBase}${path}`, {
      credentials: 'same-origin',
      ...options,
    })
    if (response.status === 401) {
      throw new Error('Unauthorized')
    }
    return response
  }

  const renderMirrors = (mirrors) => {
    if (!Array.isArray(mirrors) || !mirrors.length) {
      elements.mirrorsBody.innerHTML =
        '<tr><td colspan="6" class="admin-muted small">No mirrors configured.</td></tr>'
      return
    }

    elements.mirrorsBody.innerHTML = mirrors
      .map((mirror) => {
        const heartbeat = mirror.heartbeat
        const state = heartbeat?.connectionState ?? 'unknown'
        const reconnects = heartbeat?.reconnectCount ?? 0
        const lastEvent = formatTime(heartbeat?.lastEventAt)
        const errorNote = heartbeat?.lastError
          ? `<span class="admin-muted small d-block">${escapeHtml(heartbeat.lastError)}</span>`
          : ''
        return `<tr>
          <td>${escapeHtml(mirror.index)}</td>
          <td><code class="small">${escapeHtml(mirror.targetUrl)}</code>${errorNote}</td>
          <td>${escapeHtml(state)}</td>
          <td>${escapeHtml(reconnects)}</td>
          <td class="small">${escapeHtml(lastEvent)}</td>
          <td>${signalBadge(mirror.stale)}</td>
        </tr>`
      })
      .join('')
  }

  const renderWorkers = (workers) => {
    if (!Array.isArray(workers) || !workers.length) {
      elements.workersBody.innerHTML =
        '<tr><td colspan="4" class="admin-muted small">No workers configured.</td></tr>'
      return
    }

    elements.workersBody.innerHTML = workers
      .map((worker) => {
        const heartbeat = worker.heartbeat
        const finished = formatTime(heartbeat?.lastRunFinishedAt ?? heartbeat?.updatedAt)
        const lastError = heartbeat?.lastError ?? '—'
        return `<tr>
          <td>${escapeHtml(worker.label)}</td>
          <td class="small">${escapeHtml(finished)}</td>
          <td class="small">${escapeHtml(lastError)}</td>
          <td>${workerSignalBadge(worker)}</td>
        </tr>`
      })
      .join('')
  }

  const renderNip05 = (rows, pagination) => {
    if (!Array.isArray(rows) || !rows.length) {
      elements.nip05Body.innerHTML = '<tr><td colspan="7" class="admin-muted small">No matching verifications.</td></tr>'
    } else {
      elements.nip05Body.innerHTML = rows
        .map(
          (row) => `<tr>
            <td><code class="small" title="${escapeAttr(row.pubkey)}">${escapeHtml(shortPubkey(row.pubkey))}</code></td>
            <td class="small">${escapeHtml(row.nip05)}</td>
            <td>${row.isVerified ? 'yes' : 'no'}</td>
            <td>${escapeHtml(row.failureCount)}</td>
            <td class="small">${escapeHtml(formatTime(row.lastVerifiedAt))}</td>
            <td>${row.stale ? 'yes' : 'no'}</td>
            <td><button type="button" class="btn btn-console btn-sm" data-reverify-pubkey="${escapeAttr(row.pubkey)}">Reverify</button></td>
          </tr>`,
        )
        .join('')
    }

    if (elements.nip05Pagination && pagination) {
      const { offset, limit, total } = pagination
      elements.nip05Pagination.replaceChildren()

      const summary = document.createElement('span')
      summary.textContent = `Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total}`
      elements.nip05Pagination.append(summary)

      if (total > limit) {
        const controls = document.createElement('span')
        controls.className = 'ms-2'

        const previous = document.createElement('button')
        previous.type = 'button'
        previous.className = 'btn btn-console btn-sm me-1'
        previous.textContent = 'Previous'
        previous.disabled = offset <= 0
        previous.addEventListener('click', () => {
          nip05Offset = Math.max(0, offset - limit)
          void loadNip05()
        })

        const next = document.createElement('button')
        next.type = 'button'
        next.className = 'btn btn-console btn-sm'
        next.textContent = 'Next'
        next.disabled = offset + limit >= total
        next.addEventListener('click', () => {
          nip05Offset = offset + limit
          void loadNip05()
        })

        controls.append(previous, next)
        elements.nip05Pagination.append(controls)
      }
    }
  }

  const renderStorage = (counts) => {
    if (!Array.isArray(counts) || !counts.length) {
      elements.storageBody.innerHTML =
        '<tr><td colspan="2" class="admin-muted small">No counts returned.</td></tr>'
      return
    }

    elements.storageBody.innerHTML = counts
      .map(
        (row) => `<tr>
          <td><code class="small">${escapeHtml((row.kinds ?? []).join(', '))}</code></td>
          <td>${escapeHtml(row.count)}</td>
        </tr>`,
      )
      .join('')
  }

  const hideNip05Error = () => elements.nip05Error?.classList.add('d-none')
  const showNip05Error = (message) => {
    if (!elements.nip05Error) {
      return
    }
    elements.nip05Error.textContent = message
    elements.nip05Error.classList.remove('d-none')
  }

  const hideStorageError = () => elements.storageError?.classList.add('d-none')
  const showStorageError = (message) => {
    if (!elements.storageError) {
      return
    }
    elements.storageError.textContent = message
    elements.storageError.classList.remove('d-none')
  }

  const loadMirrors = async () => {
    const response = await adminFetch('/ops/mirrors')
    if (!response.ok) {
      throw new Error('Failed to load mirrors')
    }
    const payload = await response.json()
    renderMirrors(payload.mirrors)
    if (elements.mirrorsSync) {
      elements.mirrorsSync.innerHTML = `<span class="prompt-char">&gt;</span> mirrors: updated ${formatTime(new Date().toISOString())}`
    }
  }

  const loadWorkers = async () => {
    const response = await adminFetch('/ops/workers')
    if (!response.ok) {
      throw new Error('Failed to load workers')
    }
    const payload = await response.json()
    renderWorkers(payload.workers)
    if (elements.workersSync) {
      elements.workersSync.innerHTML = `<span class="prompt-char">&gt;</span> workers: updated ${formatTime(new Date().toISOString())}`
    }
  }

  const buildNip05Query = () => {
    const params = new URLSearchParams()
    params.set('limit', String(nip05Limit))
    params.set('offset', String(nip05Offset))

    const domain = elements.nip05Domain?.value.trim()
    if (domain) {
      params.set('domain', domain)
    }

    const verified = elements.nip05Verified?.value
    if (verified) {
      params.set('verified', verified)
    }

    const stale = elements.nip05Stale?.value
    if (stale) {
      params.set('stale', stale)
    }

    const minFailures = elements.nip05MinFailures?.value
    if (minFailures !== undefined && minFailures !== '') {
      params.set('minFailures', minFailures)
    }

    return params.toString()
  }

  const loadNip05 = async () => {
    hideNip05Error()
    const response = await adminFetch(`/ops/nip05-verifications?${buildNip05Query()}`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      showNip05Error(payload.error ?? 'Failed to load NIP-05 verifications')
      return
    }
    renderNip05(payload.verifications, payload.pagination)
  }

  const loadStorage = async () => {
    hideStorageError()
    const kinds = elements.storageKinds?.value.trim()
    if (!kinds) {
      showStorageError('Enter at least one kind.')
      return
    }

    const params = new URLSearchParams({ kinds })
    const since = elements.storageSince?.value
    const until = elements.storageUntil?.value
    if (since) {
      params.set('since', since)
    }
    if (until) {
      params.set('until', until)
    }

    const response = await adminFetch(`/ops/storage/counts?${params.toString()}`)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      showStorageError(payload.error ?? 'Storage count query failed')
      return
    }
    renderStorage(payload.counts)
  }

  const reverify = async (pubkey) => {
    hideNip05Error()
    const response = await adminFetch(`/ops/nip05-verifications/${encodeURIComponent(pubkey)}/reverify`, {
      method: 'POST',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      showNip05Error(payload.error ?? 'Re-verification failed')
      return
    }
    await loadNip05()
  }

  const refreshAll = async () => {
    try {
      await Promise.all([loadMirrors(), loadWorkers(), loadNip05()])
    } catch {
      showNip05Error('Unable to refresh operations data.')
    }
  }

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  const startPolling = () => {
    stopPolling()
    pollTimer = setInterval(() => {
      void refreshAll()
    }, 30_000)
  }

  const resetNip05Filters = () => {
    nip05Offset = 0
    void loadNip05()
  }

  elements.nip05Refresh?.addEventListener('click', resetNip05Filters)
  elements.nip05Domain?.addEventListener('change', resetNip05Filters)
  elements.nip05Verified?.addEventListener('change', resetNip05Filters)
  elements.nip05Stale?.addEventListener('change', resetNip05Filters)
  elements.nip05MinFailures?.addEventListener('change', resetNip05Filters)

  elements.storageRun?.addEventListener('click', () => {
    void loadStorage()
  })

  elements.nip05Body?.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) {
      return
    }
    const pubkey = target.getAttribute('data-reverify-pubkey')
    if (!pubkey) {
      return
    }
    void reverify(pubkey)
  })

  window.__ADMIN_OPS__ = {
    load: () => {
      nip05Offset = 0
      void refreshAll()
      startPolling()
    },
    stop: () => {
      stopPolling()
    },
  }
})()
