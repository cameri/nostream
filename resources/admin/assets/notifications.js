(() => {
  const config = window.__ADMIN_DASHBOARD__ || { pathPrefix: '' }
  const adminBase = `${config.pathPrefix || ''}/admin`

  const REDACTED = '***'

  const elements = {
    enabled: document.getElementById('notifications-enabled'),
    eventsFieldset: document.getElementById('notifications-events-fieldset'),
    saveButton: document.getElementById('notifications-save-button'),
    reloadButton: document.getElementById('notifications-reload-button'),
    addTargetButton: document.getElementById('notifications-add-target-button'),
    targetsRoot: document.getElementById('notifications-targets'),
    error: document.getElementById('notifications-error'),
    success: document.getElementById('notifications-success'),
    retryMax: document.getElementById('notifications-retry-max'),
    retryDelay: document.getElementById('notifications-retry-delay'),
    logRetention: document.getElementById('notifications-log-retention'),
    logStatus: document.getElementById('notifications-log-status'),
    logEvent: document.getElementById('notifications-log-event'),
    logRefresh: document.getElementById('notifications-log-refresh'),
    logMore: document.getElementById('notifications-log-more'),
    logBody: document.getElementById('notifications-log-body'),
  }

  if (!elements.targetsRoot) {
    return
  }

  let notificationsConfig = null
  let notificationsLoaded = false
  let logLimit = 25

  const eventInputs = () => document.querySelectorAll('#notifications-events-fieldset [data-event-key]')

  const hideAlerts = () => {
    elements.error?.classList.add('d-none')
    elements.success?.classList.add('d-none')
  }

  const showError = (message) => {
    if (!elements.error) {
      return
    }
    elements.error.textContent = message
    elements.error.classList.remove('d-none')
  }

  const showSuccess = (message) => {
    if (!elements.success) {
      return
    }
    elements.success.textContent = message
    elements.success.classList.remove('d-none')
  }

  const defaultEvents = () => ({
    'admission.invoice.created': true,
    'admission.invoice.paid': true,
    'admission.invoice.failed': true,
    'settings.changed': true,
    'relay.restarted': false,
  })

  const newTargetId = () => {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID()
    }
    return `tgt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  const createEmptyTarget = () => ({
    id: newTargetId(),
    type: 'http',
    enabled: true,
    url: '',
    botToken: '',
    chatId: '',
  })

  const setTestButtonEnabled = (card, enabled) => {
    const button = card.querySelector('[data-action="test-target"]')
    if (!button) {
      return
    }
    button.disabled = !enabled
    if (enabled) {
      button.removeAttribute('title')
    } else {
      button.title = 'Save notification settings before testing this target.'
    }
  }

  const readEventsFromForm = () => {
    const events = { ...defaultEvents(), ...(notificationsConfig?.events ?? {}) }
    eventInputs().forEach((input) => {
      const key = input.dataset.eventKey
      if (key) {
        events[key] = input.checked
      }
    })
    return events
  }

  const readTargetsFromDom = () => {
    const cards = elements.targetsRoot.querySelectorAll('[data-target-id]')
    return [...cards].map((card) => {
      const id = card.dataset.targetId
      const type = card.querySelector('[data-target-field="type"]')?.value ?? 'http'
      const enabled = card.querySelector('[data-target-field="enabled"]')?.checked ?? true
      const urlInput = card.querySelector('[data-target-field="url"]')
      const botTokenInput = card.querySelector('[data-target-field="botToken"]')
      const chatIdInput = card.querySelector('[data-target-field="chatId"]')

      const target = { id, type, enabled }

      const url = urlInput?.value?.trim() ?? ''
      if (url && url !== REDACTED) {
        target.url = url
      } else if (url === REDACTED) {
        target.url = REDACTED
      }

      const botToken = botTokenInput?.value?.trim() ?? ''
      if (botToken && botToken !== REDACTED) {
        target.botToken = botToken
      } else if (botToken === REDACTED) {
        target.botToken = REDACTED
      }

      const chatId = chatIdInput?.value?.trim() ?? ''
      if (chatId) {
        target.chatId = chatId
      }

      return target
    })
  }

  const buildPatchBody = () => ({
    enabled: elements.enabled?.checked ?? false,
    events: readEventsFromForm(),
    targets: readTargetsFromDom(),
    retry: {
      maxAttempts: Number(elements.retryMax?.value ?? 5),
      baseDelayMs: Number(elements.retryDelay?.value ?? 1000),
    },
    deliveryLogRetentionDays: Number(elements.logRetention?.value ?? 30),
  })

  const appendOption = (select, value, label) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.appendChild(option)
  }

  const renderTargetCard = (target, { saved = true } = {}) => {
    const card = document.createElement('article')
    card.className = 'panel-card notifications-target-card mb-2'
    card.dataset.targetId = target.id

    const header = document.createElement('div')
    header.className = 'd-flex flex-wrap justify-content-between align-items-center gap-2 mb-2'

    const headerLeft = document.createElement('div')
    headerLeft.className = 'd-flex align-items-center gap-2 flex-wrap'

    const badge = document.createElement('span')
    badge.className = 'module-code'
    badge.textContent = 'TGT'

    const typeSelect = document.createElement('select')
    typeSelect.dataset.targetField = 'type'
    typeSelect.className = 'form-select form-select-sm console-input notifications-target-type'
    appendOption(typeSelect, 'http', 'HTTP')
    appendOption(typeSelect, 'discord', 'Discord')
    appendOption(typeSelect, 'slack', 'Slack')
    appendOption(typeSelect, 'telegram', 'Telegram')
    typeSelect.value = target.type ?? 'http'

    const enabledWrap = document.createElement('div')
    enabledWrap.className = 'form-check form-switch mb-0'
    const enabledInput = document.createElement('input')
    enabledInput.type = 'checkbox'
    enabledInput.role = 'switch'
    enabledInput.className = 'form-check-input'
    enabledInput.dataset.targetField = 'enabled'
    enabledInput.checked = target.enabled !== false
    const enabledLabel = document.createElement('label')
    enabledLabel.className = 'form-check-label small'
    enabledLabel.textContent = 'Enabled'
    enabledWrap.append(enabledInput, enabledLabel)

    headerLeft.append(badge, typeSelect, enabledWrap)

    const headerActions = document.createElement('div')
    headerActions.className = 'd-flex gap-2'
    const testButton = document.createElement('button')
    testButton.type = 'button'
    testButton.className = 'btn btn-console btn-sm'
    testButton.dataset.action = 'test-target'
    testButton.textContent = 'Test'
    const removeButton = document.createElement('button')
    removeButton.type = 'button'
    removeButton.className = 'btn btn-console btn-sm'
    removeButton.dataset.action = 'remove-target'
    removeButton.textContent = 'Remove'
    headerActions.append(testButton, removeButton)
    header.append(headerLeft, headerActions)

    const statusEl = document.createElement('p')
    statusEl.className = 'notifications-target-status small mb-2 admin-muted'
    statusEl.dataset.targetStatus = ''
    statusEl.setAttribute('aria-live', 'polite')

    const fieldsRow = document.createElement('div')
    fieldsRow.className = 'row g-2'

    const urlCol = document.createElement('div')
    urlCol.className = 'col-12 col-lg-6'
    const urlLabel = document.createElement('label')
    urlLabel.className = 'form-label field-label small mb-1'
    urlLabel.textContent = 'Webhook URL'
    const urlInput = document.createElement('input')
    urlInput.type = 'url'
    urlInput.autocomplete = 'off'
    urlInput.className = 'form-control console-input form-control-sm'
    urlInput.dataset.targetField = 'url'
    urlInput.value = target.url ?? ''
    urlCol.append(urlLabel, urlInput)

    const botCol = document.createElement('div')
    botCol.className = 'col-12 col-md-6 col-lg-3'
    const botLabel = document.createElement('label')
    botLabel.className = 'form-label field-label small mb-1'
    botLabel.textContent = 'Bot token'
    const botInput = document.createElement('input')
    botInput.type = 'password'
    botInput.autocomplete = 'off'
    botInput.className = 'form-control console-input form-control-sm'
    botInput.dataset.targetField = 'botToken'
    botInput.value = target.botToken ?? ''
    botCol.append(botLabel, botInput)

    const chatCol = document.createElement('div')
    chatCol.className = 'col-12 col-md-6 col-lg-3'
    const chatLabel = document.createElement('label')
    chatLabel.className = 'form-label field-label small mb-1'
    chatLabel.textContent = 'Chat ID'
    const chatInput = document.createElement('input')
    chatInput.type = 'text'
    chatInput.autocomplete = 'off'
    chatInput.className = 'form-control console-input form-control-sm'
    chatInput.dataset.targetField = 'chatId'
    chatInput.value = target.chatId ?? ''
    chatCol.append(chatLabel, chatInput)

    fieldsRow.append(urlCol, botCol, chatCol)
    card.append(header, statusEl, fieldsRow)

    removeButton.addEventListener('click', () => {
      card.remove()
      if (!elements.targetsRoot.querySelector('[data-target-id]')) {
        elements.targetsRoot.innerHTML = '<p class="admin-muted small mb-0">No targets configured.</p>'
      }
    })

    testButton.addEventListener('click', () => {
      void testTarget(card.dataset.targetId, card)
    })

    setTestButtonEnabled(card, saved)

    return card
  }

  const renderTargets = (targets) => {
    elements.targetsRoot.replaceChildren()
    if (!Array.isArray(targets) || targets.length === 0) {
      elements.targetsRoot.innerHTML = '<p class="admin-muted small mb-0">No targets configured.</p>'
      return
    }

    targets.forEach((target) => {
      elements.targetsRoot.appendChild(renderTargetCard(target, { saved: true }))
    })
  }

  const applyConfigToForm = (config) => {
    notificationsConfig = config
    if (elements.enabled) {
      elements.enabled.checked = config.enabled === true
    }

    eventInputs().forEach((input) => {
      const key = input.dataset.eventKey
      input.checked = config.events?.[key] ?? defaultEvents()[key] ?? false
    })

    if (elements.retryMax) {
      elements.retryMax.value = String(config.retry?.maxAttempts ?? 5)
    }
    if (elements.retryDelay) {
      elements.retryDelay.value = String(config.retry?.baseDelayMs ?? 1000)
    }
    if (elements.logRetention) {
      elements.logRetention.value = String(config.deliveryLogRetentionDays ?? 30)
    }

    renderTargets(config.targets ?? [])
  }

  const loadNotifications = async (force = false) => {
    if (notificationsLoaded && !force) {
      return
    }

    hideAlerts()

    try {
      const response = await fetch(`${adminBase}/notifications`, { credentials: 'include' })
      if (response.status === 401) {
        return
      }
      if (!response.ok) {
        showError('Unable to load notification settings.')
        return
      }

      const body = await response.json()
      applyConfigToForm(body.notifications ?? {})
      notificationsLoaded = true
      logLimit = 25
      await loadDeliveryLog(true)
    } catch {
      showError('Network error while loading notifications.')
    }
  }

  const saveNotifications = async () => {
    hideAlerts()
    elements.saveButton.disabled = true

    try {
      const response = await fetch(`${adminBase}/notifications`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPatchBody()),
      })

      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        const issues = Array.isArray(body.issues) ? body.issues.map((i) => `${i.path}: ${i.message}`).join(' | ') : ''
        showError(body.error ? `${body.error}${issues ? ` — ${issues}` : ''}` : 'Save failed.')
        return
      }

      applyConfigToForm(body.notifications ?? {})
      showSuccess('Notification settings saved.')
    } catch {
      showError('Network error while saving notifications.')
    } finally {
      elements.saveButton.disabled = false
    }
  }

  const testTarget = async (targetId, card) => {
    const statusEl = card.querySelector('[data-target-status]')
    if (statusEl) {
      statusEl.textContent = 'Sending test…'
      statusEl.classList.remove('text-danger', 'text-success')
    }

    try {
      const response = await fetch(`${adminBase}/notifications/test`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId }),
      })

      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        if (statusEl) {
          statusEl.textContent = body.error || 'Test delivery failed.'
          statusEl.classList.add('text-danger')
        }
        return
      }

      if (statusEl) {
        statusEl.textContent = 'Test delivery succeeded.'
        statusEl.classList.add('text-success')
      }

      logLimit = 25
      await loadDeliveryLog(true)
    } catch {
      if (statusEl) {
        statusEl.textContent = 'Network error during test delivery.'
        statusEl.classList.add('text-danger')
      }
    }
  }

  const formatLogTime = (iso) => {
    if (!iso) {
      return '—'
    }
    return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '')
  }

  const renderLogRows = (entries) => {
    if (!elements.logBody) {
      return
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      elements.logBody.innerHTML = '<tr><td colspan="5" class="admin-muted small">No delivery log entries.</td></tr>'
      return
    }

    elements.logBody.replaceChildren()
    entries.forEach((entry) => {
      const row = document.createElement('tr')
      const statusClass = entry.status === 'success' ? 'notifications-status-ok' : 'notifications-status-failed'

      const timeCell = document.createElement('td')
      timeCell.textContent = formatLogTime(entry.createdAt)

      const eventCell = document.createElement('td')
      const eventCode = document.createElement('code')
      eventCode.className = 'small'
      eventCode.textContent = entry.eventType ?? '—'
      eventCell.appendChild(eventCode)

      const targetCell = document.createElement('td')
      const targetType = document.createElement('span')
      targetType.className = 'small'
      targetType.textContent = entry.targetType ?? '—'
      const targetId = document.createElement('span')
      targetId.className = 'admin-muted small'
      targetId.textContent = entry.targetId ? ` ${entry.targetId}` : ''
      targetCell.append(targetType, targetId)

      const statusCell = document.createElement('td')
      const statusSpan = document.createElement('span')
      statusSpan.className = statusClass
      statusSpan.textContent = entry.status ?? '—'
      statusCell.appendChild(statusSpan)

      const errorCell = document.createElement('td')
      errorCell.className = 'small text-break'
      errorCell.textContent = entry.errorSnippet ?? '—'

      row.append(timeCell, eventCell, targetCell, statusCell, errorCell)
      elements.logBody.appendChild(row)
    })
  }

  const loadDeliveryLog = async (reset = false) => {
    if (reset) {
      logLimit = 25
    }

    const params = new URLSearchParams({ limit: String(logLimit) })
    const status = elements.logStatus?.value?.trim()
    const eventType = elements.logEvent?.value?.trim()
    if (status) {
      params.set('status', status)
    }
    if (eventType) {
      params.set('eventType', eventType)
    }

    try {
      const response = await fetch(`${adminBase}/notifications/deliveries?${params.toString()}`, {
        credentials: 'include',
      })

      if (!response.ok) {
        showError('Unable to load delivery log.')
        return
      }

      const body = await response.json()
      renderLogRows(body.entries ?? [])
    } catch {
      showError('Network error while loading delivery log.')
    }
  }

  elements.saveButton?.addEventListener('click', () => {
    void saveNotifications()
  })

  elements.reloadButton?.addEventListener('click', () => {
    notificationsLoaded = false
    void loadNotifications(true)
  })

  elements.addTargetButton?.addEventListener('click', () => {
    const placeholder = elements.targetsRoot.querySelector('.admin-muted')
    if (placeholder && !elements.targetsRoot.querySelector('[data-target-id]')) {
      elements.targetsRoot.replaceChildren()
    }
    elements.targetsRoot.appendChild(renderTargetCard(createEmptyTarget(), { saved: false }))
  })

  elements.logRefresh?.addEventListener('click', () => {
    void loadDeliveryLog(true)
  })

  elements.logMore?.addEventListener('click', () => {
    logLimit = Math.min(logLimit + 25, 500)
    void loadDeliveryLog(false)
  })

  window.__ADMIN_NOTIFICATIONS__ = {
    load: loadNotifications,
  }
})()
