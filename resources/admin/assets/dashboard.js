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
  const themeToggle = document.getElementById('theme-toggle')
  const liveClock = document.getElementById('live-clock')
  const menuToggle = document.getElementById('menu-toggle')
  const navOverlay = document.getElementById('nav-overlay')
  const navPanel = document.getElementById('dashboard-nav')
  const navItems = document.querySelectorAll('.nav-item')
  const systemAlert = document.getElementById('system-alert')

  let metricsSource
  let reconnectTimer
  let reconnectAttempt = 0
  let streamClosedIntentionally = false
  let lastSnapshot
  let relativeTimeTimer
  let staleCheckTimer
  const staleThresholdMs = 15000

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
  }

  const getTheme = () => {
    const stored = localStorage.getItem('admin_theme')
    if (stored === 'light' || stored === 'dark') {
      return stored
    }

    return 'light'
  }

  const applyTheme = (theme) => {
    document.body.setAttribute('data-theme', theme)
    if (themeToggle) {
      themeToggle.textContent = theme === 'dark' ? 'Dark' : 'Light'
    }
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
    return tag === 'input' || tag === 'textarea' || target.isContentEditable
  }

  const showLogin = () => {
    stopMetricsStream()
    setNavOpen(false)
    loginPanel.classList.remove('d-none')
    dashboardPanel.classList.add('d-none')
    dashboardActions.classList.add('d-none')
    dashboardActions.classList.remove('d-flex')
    menuToggle?.classList.add('d-none')
    loginError.classList.add('d-none')
    passwordInput.value = ''
    lastSnapshot = undefined
  }

  const showDashboard = () => {
    loginPanel.classList.add('d-none')
    dashboardPanel.classList.remove('d-none')
    dashboardActions.classList.remove('d-none')
    dashboardActions.classList.add('d-flex')
    menuToggle?.classList.remove('d-none')

    document.querySelectorAll('.grafana-frame').forEach((frame) => {
      if (!frame.src && frame.dataset.panelId) {
        const theme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
        const baseUrl = (config.grafanaBaseUrl || config.grafanaUrl || 'http://127.0.0.1:7777').replace(/\/+$/, '')
        const dashboardUid = config.grafanaDashboardUid || 'nostream-overview'
        const params = new URLSearchParams({
          orgId: '1',
          panelId: frame.dataset.panelId,
          refresh: '5s',
          theme,
        })
        frame.src = `${baseUrl}/d-solo/${dashboardUid}?${params.toString()}`
      }
    })

    startMetricsStream()
  }

  const showLoginError = (message) => {
    loginError.textContent = message
    loginError.classList.remove('d-none')
  }

  const refreshGrafanaFrames = () => {
    const currentTheme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    const baseUrl = (config.grafanaBaseUrl || config.grafanaUrl || 'http://127.0.0.1:7777').replace(/\/+$/, '')
    const dashboardUid = config.grafanaDashboardUid || 'nostream-overview'

    document.querySelectorAll('.grafana-frame').forEach((frame) => {
      if (!frame.src || !frame.dataset.panelId) {
        return
      }

      const params = new URLSearchParams({
        orgId: '1',
        panelId: frame.dataset.panelId,
        refresh: '5s',
        theme: currentTheme,
      })
      frame.src = `${baseUrl}/d-solo/${dashboardUid}?${params.toString()}`
    })
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

    if (isTypingTarget(event.target)) {
      return
    }

    if (event.key === 't' || event.key === 'T') {
      const current = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
      const nextTheme = current === 'dark' ? 'light' : 'dark'
      localStorage.setItem('admin_theme', nextTheme)
      applyTheme(nextTheme)
      refreshGrafanaFrames()
    }

    if ((event.key === 'l' || event.key === 'L') && !dashboardPanel.classList.contains('d-none')) {
      logoutButton?.click()
    }
  })

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      navItems.forEach((candidate) => candidate.classList.remove('active'))
      item.classList.add('active')
      setNavOpen(false)
    })
  })

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
      const nextTheme = current === 'dark' ? 'light' : 'dark'
      localStorage.setItem('admin_theme', nextTheme)
      applyTheme(nextTheme)
      refreshGrafanaFrames()
    })
  }

  if (liveClock) {
    liveClock.textContent = formatClock()
    setInterval(() => {
      liveClock.textContent = formatClock()
    }, 1000)
  }

  applyTheme(getTheme())
  checkSession()
})()
