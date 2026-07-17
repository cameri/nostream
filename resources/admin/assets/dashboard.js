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

    dashboardViews.forEach((view) => {
      view.classList.toggle('d-none', view.id !== 'metrics-view')
    })
    navItems.forEach((item) => {
      item.classList.toggle('active', item.dataset.view === 'metrics-view')
    })

    document.querySelectorAll('.grafana-frame').forEach((frame) => {
      if (!frame.src && frame.dataset.panelId) {
        const theme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
        const baseUrl = (config.grafanaBaseUrl || config.grafanaUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')
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

    if (field.type === 'string' || field.type === 'select') {
      if (!String(rawValue).trim()) {
        return 'Value is required'
      }
    }

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
      void loadSettingsData()
      return
    }

    if (viewId === 'metrics-view') {
      startMetricsStream()
    }
  }

  const showLoginError = (message) => {
    loginError.textContent = message
    loginError.classList.remove('d-none')
  }

  const refreshGrafanaFrames = () => {
    const currentTheme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    const baseUrl = (config.grafanaBaseUrl || config.grafanaUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '')
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
