(() => {
  const config = window.__ADMIN_DASHBOARD__ || { pathPrefix: '' }
  const pathPrefix = config.pathPrefix || ''
  const adminBase = `${pathPrefix}/admin`

  const loginPanel = document.getElementById('login-panel')
  const dashboardPanel = document.getElementById('dashboard-panel')
  const dashboardActions = document.getElementById('dashboard-actions')
  const loginForm = document.getElementById('login-form')
  const loginError = document.getElementById('login-error')
  const loginButton = document.getElementById('login-button')
  const logoutButton = document.getElementById('logout-button')
  const copySnapshotButton = document.getElementById('copy-snapshot-button')
  const streamStatus = document.getElementById('stream-status')
  const passwordInput = document.getElementById('password')
  const liveClock = document.getElementById('live-clock')
  const menuToggle = document.getElementById('menu-toggle')
  const navOverlay = document.getElementById('nav-overlay')
  const navPanel = document.getElementById('dashboard-nav')
  const navItems = document.querySelectorAll('.nav-item')
  const systemAlert = document.getElementById('system-alert')
  const settingsCategoryList = document.getElementById('settings-category-list')
  const settingsFields = document.getElementById('settings-fields')
  const settingsError = document.getElementById('settings-error')
  const settingsSuccess = document.getElementById('settings-success')
  const settingsValidation = document.getElementById('settings-validation')
  const settingsValidateButton = document.getElementById('settings-validate-button')
  const settingsPreviewButton = document.getElementById('settings-preview-button')
  const settingsApplyButton = document.getElementById('settings-apply-button')
  const settingsDiscardButton = document.getElementById('settings-discard-button')
  const settingsRestoreButton = document.getElementById('settings-restore-button')
  const settingsReloadButton = document.getElementById('settings-reload-button')
  const settingsDiff = document.getElementById('settings-diff')
  const settingsDiffContent = document.getElementById('settings-diff-content')
  const settingsDiffSummary = document.getElementById('settings-diff-summary')
  const dashboardViews = document.querySelectorAll('.dashboard-view')
  const networkHealthSync = document.getElementById('network-health-sync')
  const networkHealthEmpty = document.getElementById('network-health-empty')
  const networkHealthSummary = document.getElementById('network-health-summary')
  const networkHealthResults = document.getElementById('network-health-results')
  const networkHealthRunAt = document.getElementById('network-health-run-at')
  const networkHealthTimelineWrap = document.getElementById('network-health-timeline-wrap')
  const networkHealthTimeline = document.getElementById('network-health-timeline')

  let settingsLoaded = false
  let settingsLoading = false
  let settingsData = {}
  let savedSettingsData = {}
  let settingsSchema = []
  let activeSettingsCategory = null
  const stagedSettingsChanges = new Map()

  let metricsSource
  let reconnectTimer
  let reconnectAttempt = 0
  let streamClosedIntentionally = false
  let lastSnapshot
  let relativeTimeTimer
  let staleCheckTimer
  const staleThresholdMs = 15000
  let networkHealthPollTimer
  const networkHealthPollIntervalMs = 60000
  const networkHealthHistoryLimit = 24
  let networkHealthHistoryRuns = []
  let selectedNetworkHealthRunAt = null
  let networkHealthHistoryPinned = false

  const statusClasses = ['status-ok', 'status-degraded', 'status-unavailable', 'status-down', 'status-no-data']

  const statusLabels = {
    system: {
      ok: '[OK]',
      degraded: '[WARN]',
      unavailable: '[NULL]',
    },
    prometheus: {
      online: '[OK]',
      noData: '[NULL]',
    },
    database: {
      healthy: '[OK]',
      fault: '[FAULT]',
    },
    redis: {
      healthy: '[OK]',
      fault: '[FAULT]',
    },
    stream: {
      offline: '[OFF]',
      init: '[SYNC]',
      live: '[LIVE]',
      stale: '[STALE]',
      parseError: '[ERR]',
      reconnect: '[RETRY]',
    },
    probeRun: {
      ok: '[OK]',
      partial: '[WARN]',
      failed: '[FAULT]',
    },
    probeCheck: {
      ok: '[OK]',
      error: '[ERR]',
      skipped: '[SKIP]',
    },
  }

  // The console only ships the nostream.dev dark (black + pink) theme.
  const getTheme = () => 'dark'

  const applyTheme = () => {
    document.body.setAttribute('data-theme', 'dark')
  }

  const formatClock = () => {
    return new Date().toISOString().slice(11, 19)
  }

  const formatRelativeTime = (timestampMs) => {
    const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000))
    if (seconds < 8) {
      return 'just now'
    }
    if (seconds < 60) {
      return `${seconds}s ago`
    }
    if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m ago`
    }

    return `${Math.floor(seconds / 3600)}h ago`
  }

  const formatTimestamp = (timestampMs) => {
    const updated = new Date(timestampMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    return `> sync: ${updated} (${formatRelativeTime(timestampMs)})`
  }

  const sumMetricValues = (...values) => {
    return values.reduce((total, value) => {
      const parsed = Number(value)
      return total + (Number.isFinite(parsed) ? parsed : 0)
    }, 0)
  }

  const formatNumber = (value, digits = 0) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return '0'
    }

    return parsed.toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    })
  }

  const setText = (id, value) => {
    const element = document.getElementById(id)
    if (element) {
      element.textContent = value
    }
  }

  const setSyncLine = (timestampMs) => {
    const element = document.getElementById('metric-updated-at')
    if (!element) {
      return
    }

    element.innerHTML = `${formatTimestamp(timestampMs)}<span class="sync-cursor" aria-hidden="true"></span>`
  }

  const setMetricValue = (id, value, digits = 0) => {
    const element = document.getElementById(id)
    if (!element) {
      return
    }

    const numberNode = element.querySelector('.metric-number')
    if (numberNode) {
      numberNode.textContent = formatNumber(value, digits)
      return
    }

    element.textContent = formatNumber(value, digits)
  }

  const setStatusText = (id, value, statusClass) => {
    const element = document.getElementById(id)
    if (!element) {
      return
    }

    element.classList.remove(...statusClasses)
    if (statusClass) {
      element.classList.add(statusClass)
    }

    const led = element.querySelector('.status-led')
    element.replaceChildren()
    if (led) {
      element.appendChild(led)
    }
    element.appendChild(document.createTextNode(value))
  }

  const setStreamStatus = (label, statusClass) => {
    if (!streamStatus) {
      return
    }

    streamStatus.className = `status-badge${statusClass ? ` ${statusClass}` : ''}`
    streamStatus.replaceChildren()

    const led = document.createElement('span')
    led.className = 'status-led'
    led.setAttribute('aria-hidden', 'true')
    streamStatus.appendChild(led)
    streamStatus.appendChild(document.createTextNode(label))
  }

  const updateSystemAlert = (snapshot) => {
    if (!systemAlert) {
      return
    }

    if (lastSnapshot?.timestamp && Date.now() - lastSnapshot.timestamp > staleThresholdMs) {
      systemAlert.textContent = '[WARN] Metrics stale — waiting for backend update.'
      systemAlert.className = 'system-alert degraded'
      return
    }

    if (snapshot.status === 'degraded') {
      systemAlert.textContent = '[WARN] System degraded — check dependency health below.'
      systemAlert.className = 'system-alert degraded'
      return
    }

    if (snapshot.status === 'unavailable') {
      systemAlert.textContent = '[NULL] Metrics unavailable — Prometheus returned no data.'
      systemAlert.className = 'system-alert unavailable'
      return
    }

    systemAlert.className = 'system-alert d-none'
    systemAlert.textContent = ''
  }

  const scheduleRelativeTimeRefresh = (timestampMs) => {
    if (relativeTimeTimer) {
      clearInterval(relativeTimeTimer)
    }

    relativeTimeTimer = setInterval(() => {
      if (lastSnapshot?.timestamp) {
        setSyncLine(lastSnapshot.timestamp)
        checkStaleSnapshot()
      }
    }, 10000)
  }

  const checkStaleSnapshot = () => {
    if (streamClosedIntentionally || !lastSnapshot?.timestamp) {
      return
    }

    const isStale = Date.now() - lastSnapshot.timestamp > staleThresholdMs
    if (isStale) {
      setStreamStatus(statusLabels.stream.stale, 'warn')
      updateSystemAlert(lastSnapshot)
      return
    }

    setStreamStatus(statusLabels.stream.live, 'live')
    updateSystemAlert(lastSnapshot)
  }

  const startStaleCheck = () => {
    if (staleCheckTimer) {
      clearInterval(staleCheckTimer)
    }

    staleCheckTimer = setInterval(checkStaleSnapshot, 3000)
  }

  const stopStaleCheck = () => {
    if (staleCheckTimer) {
      clearInterval(staleCheckTimer)
      staleCheckTimer = undefined
    }
  }

  const setNavOpen = (isOpen) => {
    document.body.classList.toggle('nav-open', isOpen)
    if (menuToggle) {
      menuToggle.setAttribute('aria-expanded', String(isOpen))
      menuToggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation')
    }
    if (navPanel) {
      navPanel.setAttribute('aria-hidden', String(!isOpen))
    }
  }

  const isTypingTarget = (target) => {
    if (!(target instanceof HTMLElement)) {
      return false
    }

    const tag = target.tagName.toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
  }

  const grafanaPanelUrl = (panelId) => {
    const baseUrl = (config.grafanaBaseUrl || config.grafanaUrl || 'http://127.0.0.1:7777').replace(/\/+$/, '')
    const dashboardUid = config.grafanaDashboardUid || 'nostream-overview'
    const params = new URLSearchParams({
      orgId: '1',
      panelId: String(panelId),
      from: 'now-15m',
      to: 'now',
      refresh: '5s',
      theme: 'dark',
      kiosk: '1',
    })
    return `${baseUrl}/d-solo/${dashboardUid}/nostream-overview?${params.toString()}`
  }

  const loadGrafanaFrames = () => {
    document.querySelectorAll('.grafana-frame').forEach((frame) => {
      if (!frame.dataset.panelId || frame.src) {
        return
      }
      frame.src = grafanaPanelUrl(frame.dataset.panelId)
    })
  }

  const unloadGrafanaFrames = () => {
    document.querySelectorAll('.grafana-frame').forEach((frame) => {
      frame.removeAttribute('src')
    })
  }

  const showLogin = () => {
    unloadGrafanaFrames()
    stopMetricsStream()
    stopNetworkHealthPolling()
    window.__ADMIN_OPS__?.stop?.()
    setNavOpen(false)
    loginPanel.classList.remove('d-none')
    dashboardPanel.classList.add('d-none')
    dashboardActions.classList.add('d-none')
    dashboardActions.classList.remove('d-flex')
    menuToggle?.classList.add('d-none')
    loginError.classList.add('d-none')
    passwordInput.value = ''
    lastSnapshot = undefined
    window.startAdminSparks?.()
  }

  const showDashboard = () => {
    loginPanel.classList.add('d-none')
    dashboardPanel.classList.remove('d-none')
    dashboardActions.classList.remove('d-none')
    dashboardActions.classList.add('d-flex')
    menuToggle?.classList.remove('d-none')
    window.stopAdminSparks?.()

    dashboardViews.forEach((view) => {
      view.classList.toggle('d-none', view.id !== 'metrics-view')
    })
    navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.view === 'metrics-view')
    })

    loadGrafanaFrames()
    startMetricsStream()
    stopNetworkHealthPolling()
    window.__ADMIN_OPS__?.stop?.()
  }

  const stopNetworkHealthPolling = () => {
    if (networkHealthPollTimer) {
      clearInterval(networkHealthPollTimer)
      networkHealthPollTimer = undefined
    }
  }

  const startNetworkHealthPolling = () => {
    stopNetworkHealthPolling()
    networkHealthPollTimer = setInterval(() => {
      void refreshNetworkHealth()
      void refreshNetworkHealthHistory()
    }, networkHealthPollIntervalMs)
  }

  const setNetworkHealthSyncLine = (message) => {
    if (!networkHealthSync) {
      return
    }

    networkHealthSync.innerHTML = `<span class="prompt-char">&gt;</span> probes: ${message}`
  }

  const probeCheckStatusClass = (status, options = {}) => {
    if (status === 'ok') {
      if (typeof options.tlsDaysUntilExpiry === 'number' && options.tlsDaysUntilExpiry < 14) {
        return 'status-degraded'
      }

      return 'status-ok'
    }
    if (status === 'error') {
      return 'status-down'
    }

    return 'status-no-data'
  }

  const summarizeProbeError = (error) => {
    const raw = String(error ?? '').replace(/\s+/g, ' ').trim()
    if (!raw) {
      return ''
    }

    const lowered = raw.toLowerCase()
    if (lowered.includes('wrong version number')) {
      return 'wrong TLS version'
    }
    if (lowered.includes('certificate has expired')) {
      return 'certificate expired'
    }
    if (lowered.includes('self-signed')) {
      return 'self-signed certificate'
    }
    if (lowered.includes('unable to verify')) {
      return 'certificate unverified'
    }
    if (lowered.includes('econnrefused')) {
      return 'connection refused'
    }
    if (lowered.includes('etimedout') || lowered.includes('timeout')) {
      return 'timed out'
    }
    if (lowered.includes('enotfound')) {
      return 'host not found'
    }
    if (lowered.includes('cert') && lowered.includes('expired')) {
      return 'certificate expired'
    }

    const opensslReason = raw.match(/SSL routines:[^:]+:([^:\s]+(?:\s[^:]+)*)/i)
    if (opensslReason?.[1]) {
      return opensslReason[1].replace(/_/g, ' ')
    }

    const lastSegment = raw.split(':').map((part) => part.trim()).filter(Boolean).at(-1)
    if (lastSegment && lastSegment.length < 80 && !/^[0-9A-F]{6,}$/i.test(lastSegment)) {
      return lastSegment
    }

    return raw.length > 72 ? `${raw.slice(0, 69)}…` : raw
  }

  const formatProbeCheckDetail = (check, formatter, options = {}) => {
    const label = statusLabels.probeCheck[check?.status] ?? statusLabels.probeCheck.skipped
    const rawDetail = typeof formatter === 'function' && check?.status === 'ok' ? formatter(check.data) : check?.error
    const fullDetail = rawDetail ? String(rawDetail) : ''
    const detail = check?.status === 'error' ? summarizeProbeError(fullDetail) : fullDetail
    const className = probeCheckStatusClass(check?.status, options)

    const needsFullDetailTitle =
      fullDetail && (fullDetail !== detail || fullDetail.length > 80)

    return {
      label,
      className,
      detail,
      title: needsFullDetailTitle ? fullDetail : '',
    }
  }

  const renderNetworkHealthTimeline = (runs) => {
    if (!networkHealthTimeline || !networkHealthTimelineWrap) {
      return
    }

    networkHealthTimeline.replaceChildren()

    if (!Array.isArray(runs) || runs.length === 0) {
      networkHealthTimelineWrap.classList.add('d-none')
      return
    }

    networkHealthTimelineWrap.classList.remove('d-none')

    runs.forEach((run) => {
      const runAt = run?.runAt
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'network-health-timeline-item'
      button.setAttribute('role', 'listitem')

      const status = run?.status ?? 'failed'
      const statusClass =
        status === 'ok' ? 'status-ok' : status === 'partial' ? 'status-degraded' : 'status-down'
      button.classList.add(statusClass)

      if (runAt && runAt === selectedNetworkHealthRunAt) {
        button.classList.add('is-selected')
      }

      const runAtMs = Date.parse(runAt ?? '')
      const label = Number.isFinite(runAtMs) ? new Date(runAtMs).toISOString() : 'Unknown run'
      const targetCount = Array.isArray(run?.results) ? run.results.length : 0
      button.textContent = `${label} · ${status} · ${targetCount} target(s)`

      button.addEventListener('click', () => {
        if (networkHealthHistoryPinned && runAt && runAt === selectedNetworkHealthRunAt) {
          networkHealthHistoryPinned = false
          selectedNetworkHealthRunAt = null
          renderNetworkHealthTimeline(networkHealthHistoryRuns)
          void refreshNetworkHealth()
          return
        }

        networkHealthHistoryPinned = true
        selectedNetworkHealthRunAt = runAt ?? null
        renderNetworkHealthTimeline(networkHealthHistoryRuns)
        renderNetworkHealthSnapshot(run)
      })

      networkHealthTimeline.appendChild(button)
    })
  }

  const renderNetworkHealthSnapshot = (snapshot) => {
    if (!networkHealthEmpty || !networkHealthSummary || !networkHealthResults) {
      return
    }

    if (!snapshot) {
      networkHealthEmpty.classList.remove('d-none')
      networkHealthSummary.classList.add('d-none')
      networkHealthResults.classList.add('d-none')
      networkHealthResults.replaceChildren()
      if (networkHealthTimelineWrap) {
        networkHealthTimelineWrap.classList.add('d-none')
      }
      setNetworkHealthSyncLine('no probe snapshot available')
      return
    }

    networkHealthEmpty.classList.add('d-none')
    networkHealthSummary.classList.remove('d-none')
    networkHealthResults.classList.remove('d-none')

    const runStatus = snapshot.status ?? 'failed'
    const runStatusClass =
      runStatus === 'ok' ? 'status-ok' : runStatus === 'partial' ? 'status-degraded' : 'status-down'
    setStatusText(
      'network-health-run-status',
      statusLabels.probeRun[runStatus] ?? statusLabels.probeRun.failed,
      runStatusClass,
    )
    setMetricValue('network-health-target-count', Array.isArray(snapshot.results) ? snapshot.results.length : 0)

    const runAtMs = Date.parse(snapshot.runAt)
    if (Number.isFinite(runAtMs)) {
      networkHealthRunAt.innerHTML = `<span class="metric-number">${new Date(runAtMs).toISOString()}</span>`
      setNetworkHealthSyncLine(`last updated ${formatRelativeTime(runAtMs)}`)
    } else {
      networkHealthRunAt.innerHTML = '<span class="metric-number">—</span>'
      setNetworkHealthSyncLine('snapshot received')
    }

    networkHealthResults.replaceChildren()

    if (!Array.isArray(snapshot.results) || snapshot.results.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'admin-muted small mb-0'
      empty.textContent = 'Probe run completed with no target results.'
      networkHealthResults.appendChild(empty)
      return
    }

    snapshot.results.forEach((result) => {
      const card = document.createElement('article')
      card.className = 'network-health-target'

      const header = document.createElement('div')
      header.className = 'network-health-target-header'

      const title = document.createElement('p')
      title.className = 'network-health-target-url mb-0'
      title.textContent = result?.target?.relayUrl ?? result?.target?.wsUrl ?? 'Unknown target'
      header.appendChild(title)

      const networkType = result?.target?.networkType
      if (networkType) {
        const badge = document.createElement('span')
        badge.className = 'network-health-network-type'
        badge.textContent = networkType
        header.appendChild(badge)
      }

      card.appendChild(header)

      const checks = document.createElement('div')
      checks.className = 'network-health-checks'

      const dns = formatProbeCheckDetail(result.dns, (data) => {
        const records = Array.isArray(data?.records) ? data.records : []

        if (records.length === 0) {
          return 'no records'
        }

        const preview = records.slice(0, 3).map((record) => {
          const ttl = typeof record?.ttl === 'number' ? ` TTL ${record.ttl}` : ''
          return `${record.type} ${record.value}${ttl}`
        })

        if (records.length > 3) {
          preview.push(`+${records.length - 3} more`)
        }

        return preview.join('; ')
      })
      const tlsDaysUntilExpiry =
        result.tls?.status === 'ok' && typeof result.tls?.data?.daysUntilExpiry === 'number'
          ? result.tls.data.daysUntilExpiry
          : undefined
      const tls = formatProbeCheckDetail(
        result.tls,
        (data) => {
          if (typeof data?.daysUntilExpiry === 'number') {
            return `${data.daysUntilExpiry}d remaining`
          }

          return data?.issuer ?? 'valid'
        },
        { tlsDaysUntilExpiry },
      )
      const wsRtt = formatProbeCheckDetail(result.wsRtt, (data) => {
        const parts = [`open ${data.rttOpenMs} ms`]

        if (typeof data.rttReadMs === 'number') {
          parts.push(`read ${data.rttReadMs} ms`)
        }

        if (typeof data.rttWriteMs === 'number') {
          parts.push(`write ${data.rttWriteMs} ms`)
        }

        if (data.nip42AuthRequired === true) {
          parts.push('NIP-42 auth required')
        }

        return parts.join(' · ')
      })
      const nip11 = formatProbeCheckDetail(result.nip11, (data) => {
        const name = data?.name ? ` ${data.name}` : ''
        return `HTTP ${data.statusCode}${name}`
      })

      const mismatches = Array.isArray(result.mismatches) ? result.mismatches : []
      if (
        result.nip11?.status === 'ok' &&
        mismatches.some((entry) => entry?.severity === 'warning')
      ) {
        nip11.className = 'status-degraded'
      }

      ;[
        ['DNS', dns],
        ['TLS', tls],
        ['WS RTT', wsRtt],
        ['NIP-11', nip11],
      ].forEach(([name, check]) => {
        const item = document.createElement('div')
        item.className = 'network-health-check'

        const label = document.createElement('p')
        label.className = 'network-health-check-label mb-0'
        label.textContent = name

        const value = document.createElement('p')
        value.className = `network-health-check-value ${check.className} mb-0`
        value.textContent = check.detail ? `${check.label} · ${check.detail}` : check.label
        if (check.title) {
          value.title = check.title
        }

        item.appendChild(label)
        item.appendChild(value)
        checks.appendChild(item)
      })

      card.appendChild(checks)

      if (mismatches.length > 0) {
        const mismatchBlock = document.createElement('div')
        mismatchBlock.className = 'network-health-mismatches'

        const heading = document.createElement('p')
        heading.className = 'network-health-mismatch-heading mb-1'
        heading.textContent = 'Advertised vs observed'
        mismatchBlock.appendChild(heading)

        const list = document.createElement('ul')
        list.className = 'network-health-mismatch-list mb-0'

        mismatches.forEach((entry) => {
          const item = document.createElement('li')
          item.className = `network-health-mismatch network-health-mismatch-${entry.severity ?? 'warning'}`
          item.textContent = entry.message ?? entry.code ?? 'Mismatch'
          list.appendChild(item)
        })

        mismatchBlock.appendChild(list)
        card.appendChild(mismatchBlock)
      }
      networkHealthResults.appendChild(card)
    })
  }

  const refreshNetworkHealth = async () => {
    try {
      const response = await fetch(`${adminBase}/network-health`, {
        credentials: 'include',
      })

      if (response.status === 401) {
        showLogin()
        return
      }

      if (!response.ok) {
        setNetworkHealthSyncLine('failed to load probe snapshot')
        return
      }

      const body = await response.json()
      const snapshot = body.snapshot ?? null
      let displaySnapshot = snapshot
      if (networkHealthHistoryPinned && selectedNetworkHealthRunAt && networkHealthHistoryRuns.length > 0) {
        const selected = networkHealthHistoryRuns.find((run) => run?.runAt === selectedNetworkHealthRunAt)
        if (selected) {
          displaySnapshot = selected
        } else {
          networkHealthHistoryPinned = false
          selectedNetworkHealthRunAt = null
        }
      }
      renderNetworkHealthSnapshot(displaySnapshot)
      if (networkHealthHistoryRuns.length > 0) {
        renderNetworkHealthTimeline(networkHealthHistoryRuns)
      }
    } catch {
      setNetworkHealthSyncLine('network error while loading probes')
    }
  }

  const refreshNetworkHealthHistory = async () => {
    if (!networkHealthTimeline) {
      return
    }

    try {
      const response = await fetch(`${adminBase}/network-health/history?limit=${networkHealthHistoryLimit}`, {
        credentials: 'include',
      })

      if (response.status === 401) {
        showLogin()
        return
      }

      if (!response.ok) {
        return
      }

      const body = await response.json()
      networkHealthHistoryRuns = Array.isArray(body.runs) ? body.runs : []
      renderNetworkHealthTimeline(networkHealthHistoryRuns)
    } catch {
      // Timeline is optional; keep the latest snapshot panel usable.
    }
  }

  const parsePathTokens = (path) => {
    const tokens = []
    const pattern = /([^.[\]]+)|\[(\d+)\]/g
    let match = pattern.exec(path)

    while (match) {
      if (match[1] !== undefined) {
        tokens.push({ type: 'key', key: match[1] })
      } else {
        tokens.push({ type: 'index', index: Number(match[2]) })
      }
      match = pattern.exec(path)
    }

    return tokens
  }

  const getByPath = (source, path) => {
    let current = source

    for (const token of parsePathTokens(path)) {
      if (current === undefined || current === null) {
        return undefined
      }

      if (token.type === 'key') {
        current = current[token.key]
        continue
      }

      current = Array.isArray(current) ? current[token.index] : undefined
    }

    return current
  }

  const hideSettingsAlerts = () => {
    settingsError?.classList.add('d-none')
    settingsSuccess?.classList.add('d-none')
    settingsValidation?.classList.add('d-none')
  }

  const showSettingsError = (message) => {
    if (!settingsError) {
      return
    }

    settingsError.textContent = message
    settingsError.classList.remove('d-none')
    settingsSuccess?.classList.add('d-none')
  }

  const showSettingsSuccess = (message) => {
    if (!settingsSuccess) {
      return
    }

    settingsSuccess.textContent = message
    settingsSuccess.classList.remove('d-none')
    settingsError?.classList.add('d-none')
  }

  const getReloadBehavior = (path) => {
    return path.startsWith('workers.') || path.startsWith('payments') || path.startsWith('network.')
      ? 'restart required'
      : 'hot reload'
  }

  const updateStagedChangesUi = () => {
    const pendingCount = stagedSettingsChanges.size

    if (settingsApplyButton) {
      settingsApplyButton.disabled = pendingCount === 0
      settingsApplyButton.textContent =
        pendingCount === 0 ? 'Apply staged changes' : `Apply ${pendingCount} staged change(s)`
    }

    if (settingsDiscardButton) {
      settingsDiscardButton.disabled = pendingCount === 0
    }

    renderSettingsCategoryList()
  }

  const formatDiffValue = (value) => {
    if (value === undefined) {
      return 'undefined'
    }

    if (value === null) {
      return 'null'
    }

    if (typeof value === 'string') {
      return value
    }

    if (typeof value === 'boolean' || typeof value === 'number') {
      return String(value)
    }

    return JSON.stringify(value)
  }

  const pathToYamlKey = (path) => {
    return path.replace(/\[(\d+)\]/g, '.$1')
  }

  const renderSettingsDiff = (options = {}) => {
    const { highlight = false, showEmptyMessage = false } = options

    if (!settingsDiffContent) {
      return
    }

    settingsDiffContent.replaceChildren()

    if (stagedSettingsChanges.size === 0) {
      const empty = document.createElement('p')
      empty.className = 'settings-diff-empty admin-muted small mb-0'
      empty.textContent = showEmptyMessage
        ? 'No pending changes to preview.'
        : 'Edit a setting to preview changes here.'
      settingsDiffContent.appendChild(empty)

      if (settingsDiffSummary) {
        settingsDiffSummary.textContent = ''
      }

      settingsDiff?.classList.toggle('highlight', highlight)
      return
    }

    for (const change of stagedSettingsChanges.values()) {
      const yamlKey = pathToYamlKey(change.path)
      const removed = document.createElement('p')
      removed.className = 'settings-diff-line removed'
      removed.textContent = `- ${yamlKey}: ${formatDiffValue(change.previous)}`

      const added = document.createElement('p')
      added.className = 'settings-diff-line added'
      added.textContent = `+ ${yamlKey}: ${formatDiffValue(change.value)}`

      const meta = document.createElement('p')
      meta.className = 'settings-diff-line meta'
      meta.textContent = `  # ${getReloadBehavior(change.path)}`

      settingsDiffContent.append(removed, added, meta)
    }

    if (settingsDiffSummary) {
      const lineCount = stagedSettingsChanges.size * 2
      settingsDiffSummary.textContent = `${lineCount} line(s) changed • ${stagedSettingsChanges.size} setting(s) pending`
    }

    settingsDiff?.classList.toggle('highlight', highlight)
  }

  const discardStagedChanges = () => {
    if (stagedSettingsChanges.size === 0) {
      return
    }

    settingsData = structuredClone(savedSettingsData)
    stagedSettingsChanges.clear()
    hideSettingsAlerts()
    renderSettingsFields()
    renderSettingsDiff()
    updateStagedChangesUi()
    showSettingsSuccess('Discarded staged changes.')
  }

  const updateFieldChangeIndicator = (wrapper, field) => {
    const pending = stagedSettingsChanges.get(field.path)
    wrapper.classList.toggle('changed', Boolean(pending))

    let wasNode = wrapper.querySelector('.settings-field-was')
    if (!pending) {
      wasNode?.remove()
      return
    }

    if (!wasNode) {
      wasNode = document.createElement('p')
      wasNode.className = 'settings-field-was'
      wrapper.insertBefore(wasNode, wrapper.querySelector('.settings-field-message'))
    }

    wasNode.textContent = `was: ${formatDiffValue(pending.previous)}`
  }

  const trackFieldChange = (field, control, wrapper, messageNode) => {
    if (messageNode) {
      messageNode.textContent = ''
      messageNode.className = 'settings-field-message mb-0'
    }

    let value
    try {
      const rawValue = readControlValue(field, control)
      const validationMessage = validateFieldInput(field, rawValue)
      if (validationMessage) {
        if (messageNode) {
          messageNode.textContent = validationMessage
          messageNode.classList.add('error')
        }
        return false
      }

      value = parseFieldValue(field, rawValue)
    } catch (error) {
      if (messageNode) {
        messageNode.textContent = error instanceof Error ? error.message : 'Invalid value'
        messageNode.classList.add('error')
      }
      return false
    }

    stageSettingsChange(field, value)
    updateFieldChangeIndicator(wrapper, field)
    return true
  }

  const syncPendingFromVisibleFields = () => {
    if (!settingsFields) {
      return
    }

    for (const wrapper of settingsFields.querySelectorAll('.settings-field')) {
      const path = wrapper.dataset.path
      const field = settingsSchema.flatMap((category) => category.settings).find((entry) => entry.path === path)
      const control = wrapper.querySelector('input, select, textarea')

      if (!field || !control) {
        continue
      }

      trackFieldChange(field, control, wrapper)
    }
  }

  const stageSettingsChange = (field, value) => {
    const previous = getByPath(savedSettingsData, field.path)
    if (JSON.stringify(previous) === JSON.stringify(value)) {
      stagedSettingsChanges.delete(field.path)
    } else {
      stagedSettingsChanges.set(field.path, { path: field.path, previous, value })
    }
    setByPathLocal(settingsData, field.path, value)
    updateStagedChangesUi()
    renderSettingsDiff()
  }

  const formatFieldValue = (field, value) => {
    if (field.type === 'boolean') {
      return Boolean(value)
    }

    if (field.type === 'number') {
      return value === undefined || value === null || value === '' ? '' : String(value)
    }

    if (field.type === 'stringArray') {
      if (!Array.isArray(value)) {
        return ''
      }

      return value.join('\n')
    }

    if (value === undefined || value === null) {
      return ''
    }

    return String(value)
  }

  const parseFieldValue = (field, rawValue) => {
    if (field.type === 'boolean') {
      return Boolean(rawValue)
    }

    if (field.type === 'number') {
      const trimmed = String(rawValue).trim()
      if (!trimmed) {
        return null
      }

      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) {
        throw new Error('Enter a valid number')
      }

      return parsed
    }

    if (field.type === 'stringArray') {
      return String(rawValue)
        .split('\n')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    }

    return String(rawValue)
  }

  const validateFieldInput = (field, rawValue) => {
    if (field.type === 'number') {
      const trimmed = String(rawValue).trim()
      if (!trimmed) {
        return 'Value is required'
      }

      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return 'Enter a valid number'
      }
    }

    // Note: We remove the client-side required check for strings/selects
    // because many metadata fields are optional and can be legitimately cleared.
    // Server validation will enforce required constraints where necessary.

    return undefined
  }

  const renderSettingsCategoryList = () => {
    if (!settingsCategoryList) {
      return
    }

    settingsCategoryList.replaceChildren()

    for (const category of settingsSchema) {
      const hasChanges = category.settings.some((field) => stagedSettingsChanges.has(field.path))
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `settings-category-button${category.value === activeSettingsCategory ? ' active' : ''}${hasChanges ? ' has-changes' : ''}`
      button.textContent = category.label
      button.dataset.category = category.value
      button.addEventListener('click', () => {
        syncPendingFromVisibleFields()
        activeSettingsCategory = category.value
        renderSettingsCategoryList()
        renderSettingsFields()
        renderSettingsDiff()
      })
      settingsCategoryList.appendChild(button)
    }
  }

  const createSettingsControl = (field, inputId) => {
    if (field.type === 'boolean') {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.className = 'form-check-input'
      input.id = inputId
      return input
    }

    if (field.type === 'select') {
      const select = document.createElement('select')
      select.className = 'form-select console-input'
      select.id = inputId

      for (const optionValue of field.options ?? []) {
        const option = document.createElement('option')
        option.value = optionValue
        option.textContent = optionValue
        select.appendChild(option)
      }

      return select
    }

    if (field.type === 'stringArray') {
      const textarea = document.createElement('textarea')
      textarea.className = 'form-control console-input'
      textarea.id = inputId
      textarea.rows = 4
      textarea.placeholder = field.placeholder ?? 'One value per line'
      return textarea
    }

    const input = document.createElement('input')
    input.className = 'form-control console-input'
    input.id = inputId
    input.type = field.type === 'number' ? 'number' : 'text'
    if (field.placeholder) {
      input.placeholder = field.placeholder
    }

    return input
  }

  const setControlValue = (field, control, value) => {
    if (field.type === 'boolean') {
      control.checked = Boolean(value)
      return
    }

    control.value = formatFieldValue(field, value)
  }

  const readControlValue = (field, control) => {
    if (field.type === 'boolean') {
      return control.checked
    }

    return control.value
  }

  const renderSettingsFields = () => {
    if (!settingsFields) {
      return
    }

    const category = settingsSchema.find((entry) => entry.value === activeSettingsCategory)
    settingsFields.replaceChildren()

    if (!category) {
      const empty = document.createElement('p')
      empty.className = 'admin-muted small mb-0'
      empty.textContent = 'Select a category to edit guided settings.'
      settingsFields.appendChild(empty)
      return
    }

    for (const field of category.settings) {
      const fieldId = `setting-${field.path.replace(/[^a-zA-Z0-9]+/g, '-')}`
      const wrapper = document.createElement('div')
      wrapper.className = 'settings-field'
      wrapper.dataset.path = field.path

      const label = document.createElement('label')
      label.className = 'form-label field-label'
      label.setAttribute('for', fieldId)
      label.textContent = field.label

      const path = document.createElement('p')
      path.className = 'settings-field-path'
      path.textContent = field.path

      const reload = document.createElement('p')
      reload.className = `settings-field-reload${getReloadBehavior(field.path) === 'restart required' ? ' restart' : ''}`
      reload.textContent =
        getReloadBehavior(field.path) === 'restart required' ? '[restart required]' : '[hot reload]'

      const control = createSettingsControl(field, fieldId)
      setControlValue(field, control, getByPath(settingsData, field.path))

      const message = document.createElement('p')
      message.className = 'settings-field-message mb-0'

      const onFieldUpdate = () => {
        if (trackFieldChange(field, control, wrapper, message)) {
          renderSettingsDiff()
        }
      }

      control.addEventListener('change', onFieldUpdate)
      if (field.type === 'number' || field.type === 'string' || field.type === 'stringArray') {
        control.addEventListener('input', onFieldUpdate)
      }

      updateFieldChangeIndicator(wrapper, field)
      wrapper.append(label, path, reload, control, message)
      settingsFields.appendChild(wrapper)
    }
  }

  const setByPathLocal = (target, path, value) => {
    const tokens = parsePathTokens(path)
    let current = target

    for (let index = 0; index < tokens.length - 1; index += 1) {
      const token = tokens[index]
      const nextToken = tokens[index + 1]

      if (token.type === 'key') {
        if (current[token.key] === undefined || current[token.key] === null) {
          current[token.key] = nextToken.type === 'index' ? [] : {}
        }
        current = current[token.key]
        continue
      }

      while (current.length <= token.index) {
        current.push(undefined)
      }

      if (current[token.index] === undefined || current[token.index] === null) {
        current[token.index] = nextToken.type === 'index' ? [] : {}
      }

      current = current[token.index]
    }

    const last = tokens[tokens.length - 1]
    if (last.type === 'key') {
      current[last.key] = value
      return
    }

    while (current.length <= last.index) {
      current.push(undefined)
    }

    current[last.index] = value
  }

  const loadSettingsData = async (force = false) => {
    if (settingsLoading) {
      return
    }

    if (settingsLoaded && !force) {
      return
    }

    settingsLoading = true
    hideSettingsAlerts()

    try {
      const [settingsResponse, schemaResponse] = await Promise.all([
        fetch(`${adminBase}/settings`, { credentials: 'include' }),
        fetch(`${adminBase}/settings/schema`, { credentials: 'include' }),
      ])

      if (settingsResponse.status === 401 || schemaResponse.status === 401) {
        showLogin()
        return
      }

      if (!settingsResponse.ok || !schemaResponse.ok) {
        showSettingsError('Unable to load settings.')
        return
      }

      const settingsBody = await settingsResponse.json()
      const schemaBody = await schemaResponse.json()

      settingsData = settingsBody.settings ?? {}
      savedSettingsData = structuredClone(settingsData)
      settingsSchema = schemaBody.categories ?? []
      activeSettingsCategory = settingsSchema[0]?.value ?? null
      stagedSettingsChanges.clear()
      updateStagedChangesUi()
      renderSettingsDiff()
      settingsLoaded = true

      renderSettingsCategoryList()
      renderSettingsFields()
    } catch {
      showSettingsError('Network error while loading settings.')
    } finally {
      settingsLoading = false
    }
  }

  const validateAllSettings = async () => {
    hideSettingsAlerts()

    try {
      const response = await fetch(`${adminBase}/settings/validate`, {
        method: 'POST',
        credentials: 'include',
      })

      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        showSettingsError('Validation request failed.')
        return
      }

      if (!settingsValidation) {
        return
      }

      settingsValidation.classList.remove('d-none', 'valid')

      if (body.valid) {
        settingsValidation.textContent = 'All settings are valid.'
        settingsValidation.classList.add('valid')
        return
      }

      const issues = Array.isArray(body.issues) ? body.issues : []
      settingsValidation.textContent = issues.map((issue) => `${issue.path}: ${issue.message}`).join(' | ')
    } catch {
      showSettingsError('Network error while validating settings.')
    }
  }

  const restoreLatestBackup = async () => {
    hideSettingsAlerts()

    try {
      const backupsResponse = await fetch(`${adminBase}/settings/backups`, { credentials: 'include' })
      const backupsBody = await backupsResponse.json().catch(() => ({}))

      if (!backupsResponse.ok) {
        showSettingsError('Unable to list settings backups.')
        return
      }

      const latestBackup = backupsBody.backups?.[0]
      if (!latestBackup?.filename) {
        showSettingsError('No settings backups are available yet.')
        return
      }

      if (!window.confirm(`Restore backup ${latestBackup.filename}? Current settings will be backed up first.`)) {
        return
      }

      const restoreResponse = await fetch(`${adminBase}/settings/restore`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ filename: latestBackup.filename }),
      })
      const restoreBody = await restoreResponse.json().catch(() => ({}))

      if (!restoreResponse.ok) {
        showSettingsError(restoreBody.error || 'Restore failed.')
        return
      }

      settingsLoaded = false
      stagedSettingsChanges.clear()
      updateStagedChangesUi()
      renderSettingsDiff()
      await loadSettingsData(true)
      showSettingsSuccess(`Restored ${latestBackup.filename}.`)
    } catch {
      showSettingsError('Network error while restoring settings backup.')
    }
  }

  const applyStagedSettings = async () => {
    syncPendingFromVisibleFields()

    if (stagedSettingsChanges.size === 0 || !settingsApplyButton) {
      return
    }

    hideSettingsAlerts()
    settingsApplyButton.disabled = true

    try {
      const response = await fetch(`${adminBase}/settings`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          changes: [...stagedSettingsChanges.values()].map(({ path, value }) => ({ path, value })),
        }),
      })
      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        const issues = Array.isArray(body.issues) ? body.issues : []
        const issueText = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
        showSettingsError(issueText || body.error || 'Settings update rejected.')
        return
      }

      const restartRequired = (body.changes ?? []).some((change) => change.reload === 'restart-required')
      const successMessage = restartRequired
        ? 'Settings saved atomically with a backup. Restart the relay to activate marked changes.'
        : 'Settings saved atomically with a backup. Changes will hot reload.'
      settingsLoaded = false
      await loadSettingsData(true)
      showSettingsSuccess(successMessage)
    } catch {
      showSettingsError('Network error while applying staged settings.')
    } finally {
      updateStagedChangesUi()
    }
  }

  const showView = (viewId) => {
    dashboardViews.forEach((view) => {
      view.classList.toggle('d-none', view.id !== viewId)
    })

    navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.view === viewId)
    })

    if (viewId === 'settings-view') {
      stopNetworkHealthPolling()
      window.__ADMIN_OPS__?.stop?.()
      stopMetricsStream()
      void loadSettingsData()
      return
    }

    if (viewId === 'notifications-view') {
      stopNetworkHealthPolling()
      window.__ADMIN_OPS__?.stop?.()
      stopMetricsStream()
      window.__ADMIN_NOTIFICATIONS__?.load?.()
      return
    }

    if (viewId === 'operations-view') {
      stopMetricsStream()
      void refreshNetworkHealth()
      void refreshNetworkHealthHistory()
      startNetworkHealthPolling()
      window.__ADMIN_OPS__?.load?.()
      return
    }

    if (viewId === 'metrics-view') {
      stopNetworkHealthPolling()
      window.__ADMIN_OPS__?.stop?.()
      startMetricsStream()
    }
  }

  const showLoginError = (message) => {
    loginError.textContent = message
    loginError.classList.remove('d-none')
  }

  const updateSnapshot = (snapshot) => {
    lastSnapshot = snapshot

    const statusClass =
      snapshot.status === 'ok'
        ? 'status-ok'
        : snapshot.status === 'degraded'
          ? 'status-degraded'
          : 'status-unavailable'

    setStatusText('metric-status', statusLabels.system[snapshot.status] ?? statusLabels.system.unavailable, statusClass)
    setStatusText(
      'metric-prometheus',
      snapshot.prometheus?.available ? statusLabels.prometheus.online : statusLabels.prometheus.noData,
      snapshot.prometheus?.available ? 'status-ok' : 'status-no-data',
    )
    setStatusText(
      'metric-database',
      snapshot.health?.database?.ok ? statusLabels.database.healthy : statusLabels.database.fault,
      snapshot.health?.database?.ok ? 'status-ok' : 'status-down',
    )
    setStatusText(
      'metric-redis',
      snapshot.health?.redis?.ok ? statusLabels.redis.healthy : statusLabels.redis.fault,
      snapshot.health?.redis?.ok ? 'status-ok' : 'status-down',
    )

    setMetricValue('metric-events-per-second', snapshot.metrics?.eventsPerSecond, 2)
    setMetricValue('metric-events-rejected-per-second', snapshot.metrics?.eventsRejectedPerSecond, 2)
    setMetricValue('metric-active-connections', snapshot.metrics?.activeConnections)
    setMetricValue('metric-cpu-load', snapshot.metrics?.cpuLoadPercent, 1)
    setMetricValue(
      'metric-events-total',
      sumMetricValues(snapshot.metrics?.eventsAcceptedTotal, snapshot.metrics?.eventsRejectedTotal),
    )
    setMetricValue('metric-accepted-total', snapshot.metrics?.eventsAcceptedTotal)
    setMetricValue('metric-rejected-total', snapshot.metrics?.eventsRejectedTotal)
    setMetricValue('metric-memory-used', snapshot.metrics?.memoryUsedMb, 1)

    setSyncLine(snapshot.timestamp)
    scheduleRelativeTimeRefresh(snapshot.timestamp)
    updateSystemAlert(snapshot)
  }

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
  }

  const stopMetricsStream = () => {
    streamClosedIntentionally = true
    clearReconnectTimer()
    if (relativeTimeTimer) {
      clearInterval(relativeTimeTimer)
      relativeTimeTimer = undefined
    }
    stopStaleCheck()

    if (metricsSource) {
      metricsSource.close()
      metricsSource = undefined
    }

    setStreamStatus(statusLabels.stream.offline)
  }

  const startMetricsStream = () => {
    streamClosedIntentionally = false
    stopMetricsStream()
    streamClosedIntentionally = false
    setStreamStatus(statusLabels.stream.init)

    metricsSource = new EventSource(`${adminBase}/metrics`, { withCredentials: true })

    metricsSource.onopen = () => {
      reconnectAttempt = 0
      setStreamStatus(statusLabels.stream.live, 'live')
      startStaleCheck()
    }

    metricsSource.onmessage = (event) => {
      try {
        updateSnapshot(JSON.parse(event.data))
        checkStaleSnapshot()
      } catch {
        setStreamStatus(statusLabels.stream.parseError, 'error')
      }
    }

    metricsSource.onerror = () => {
      if (streamClosedIntentionally) {
        return
      }

      if (metricsSource) {
        metricsSource.close()
        metricsSource = undefined
      }

      setStreamStatus(statusLabels.stream.reconnect, 'warn')

      const delayMs = Math.min(30000, 1000 * 2 ** reconnectAttempt)
      reconnectAttempt += 1
      clearReconnectTimer()
      reconnectTimer = setTimeout(() => {
        startMetricsStream()
      }, delayMs)
    }
  }

  const copyLatestSnapshot = async () => {
    if (!copySnapshotButton || !lastSnapshot) {
      return
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(lastSnapshot, null, 2))
      const original = copySnapshotButton.textContent
      copySnapshotButton.textContent = 'Copied'
      copySnapshotButton.classList.add('copied')
      setTimeout(() => {
        copySnapshotButton.textContent = original
        copySnapshotButton.classList.remove('copied')
      }, 2000)
    } catch {
      copySnapshotButton.textContent = 'Failed'
      setTimeout(() => {
        copySnapshotButton.textContent = 'Copy JSON'
      }, 2000)
    }
  }

  const checkSession = async () => {
    const response = await fetch(`${adminBase}/session`, {
      credentials: 'include',
    })

    if (response.status === 401) {
      showLogin()
      return
    }

    if (!response.ok) {
      showLoginError('Unable to verify session.')
      showLogin()
      return
    }

    const body = await response.json()
    if (body.authenticated) {
      showDashboard()
      return
    }

    showLogin()
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    loginError.classList.add('d-none')
    loginButton.disabled = true

    try {
      const response = await fetch(`${adminBase}/login`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          password: passwordInput.value,
        }),
      })

      if (response.status === 401) {
        showLoginError('Invalid password.')
        return
      }

      if (!response.ok) {
        showLoginError('Sign in failed.')
        return
      }

      showDashboard()
    } catch {
      showLoginError('Network error. Try again.')
    } finally {
      loginButton.disabled = false
    }
  })

  logoutButton.addEventListener('click', async () => {
    try {
      await fetch(`${adminBase}/logout`, {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // Still return to the login screen if the network request fails.
    }

    showLogin()
  })

  copySnapshotButton?.addEventListener('click', () => {
    void copyLatestSnapshot()
  })

  if (menuToggle) {
    menuToggle.addEventListener('click', () => {
      const isOpen = document.body.classList.contains('nav-open')
      setNavOpen(!isOpen)
    })
  }

  navOverlay?.addEventListener('click', () => {
    setNavOpen(false)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setNavOpen(false)
      return
    }

    if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) {
      return
    }

    if ((event.key === 'l' || event.key === 'L') && !dashboardPanel.classList.contains('d-none')) {
      logoutButton?.click()
    }
  })

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const viewId = item.dataset.view
      if (!viewId) {
        return
      }

      showView(viewId)
      setNavOpen(false)
    })
  })

  settingsValidateButton?.addEventListener('click', () => {
    void validateAllSettings()
  })

  settingsPreviewButton?.addEventListener('click', () => {
    syncPendingFromVisibleFields()
    renderSettingsDiff({ highlight: true, showEmptyMessage: true })
    settingsDiff?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })

  settingsApplyButton?.addEventListener('click', () => {
    void applyStagedSettings()
  })

  settingsDiscardButton?.addEventListener('click', () => {
    discardStagedChanges()
  })

  settingsRestoreButton?.addEventListener('click', () => {
    void restoreLatestBackup()
  })

  settingsReloadButton?.addEventListener('click', () => {
    settingsLoaded = false
    void loadSettingsData(true)
  })

  if (liveClock) {
    liveClock.textContent = formatClock()
    setInterval(() => {
      liveClock.textContent = formatClock()
    }, 1000)
  }

  applyTheme(getTheme())
  checkSession()
})()
