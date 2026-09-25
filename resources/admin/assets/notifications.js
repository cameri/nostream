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

  const createEmptyTarget = () => ({
    id: crypto.randomUUID(),
    type: 'http',
    enabled: true,
    url: '',
    botToken: '',
    chatId: '',
  })

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

  const renderTargetCard = (target) => {
    const card = document.createElement('article')
    card.className = 'panel-card notifications-target-card mb-2'
    card.dataset.targetId = target.id

    const urlValue = target.url ?? ''
    const botTokenValue = target.botToken ?? ''

    card.innerHTML = `
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="module-code">TGT</span>
          <label class="visually-hidden" for="target-type-${target.id}">Target type</label>
          <select id="target-type-${target.id}" data-target-field="type" class="form-select form-select-sm console-input notifications-target-type">
            <option value="http">HTTP</option>
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
            <option value="telegram">Telegram</option>
          </select>
          <div class="form-check form-switch mb-0">
            <input id="target-enabled-${target.id}" data-target-field="enabled" class="form-check-input" type="checkbox" role="switch">
            <label class="form-check-label small" for="target-enabled-${target.id}">Enabled</label>
          </div>
        </div>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-console btn-sm" data-action="test-target">Test</button>
          <button type="button" class="btn btn-console btn-sm" data-action="remove-target">Remove</button>
        </div>
      </div>
      <p class="notifications-target-status small mb-2 admin-muted" data-target-status aria-live="polite"></p>
      <div class="row g-2">
        <div class="col-12 col-lg-6">
          <label class="form-label field-label small mb-1" for="target-url-${target.id}">Webhook URL</label>
          <input id="target-url-${target.id}" data-target-field="url" class="form-control console-input form-control-sm" type="url" autocomplete="off">
        </div>
        <div class="col-12 col-md-6 col-lg-3">
          <label class="form-label field-label small mb-1" for="target-bot-${target.id}">Bot token</label>
          <input id="target-bot-${target.id}" data-target-field="botToken" class="form-control console-input form-control-sm" type="password" autocomplete="off">
        </div>
        <div class="col-12 col-md-6 col-lg-3">
          <label class="form-label field-label small mb-1" for="target-chat-${target.id}">Chat ID</label>
          <input id="target-chat-${target.id}" data-target-field="chatId" class="form-control console-input form-control-sm" type="text" autocomplete="off">
        </div>
      </div>
    `

    card.querySelector('[data-target-field="type"]').value = target.type
    card.querySelector('[data-target-field="enabled"]').checked = target.enabled !== false
    card.querySelector('[data-target-field="url"]').value = urlValue
    card.querySelector('[data-target-field="botToken"]').value = botTokenValue
    card.querySelector('[data-target-field="chatId"]').value = target.chatId ?? ''

    card.querySelector('[data-action="remove-target"]')?.addEventListener('click', () => {
      card.remove()
      if (!elements.targetsRoot.querySelector('[data-target-id]')) {
        elements.targetsRoot.innerHTML = '<p class="admin-muted small mb-0">No targets configured.</p>'
      }
    })

    card.querySelector('[data-action="test-target"]')?.addEventListener('click', () => {
      void testTarget(target.id, card)
    })

    return card
  }

  const renderTargets = (targets) => {
    elements.targetsRoot.replaceChildren()
    if (!Array.isArray(targets) || targets.length === 0) {
      elements.targetsRoot.innerHTML = '<p class="admin-muted small mb-0">No targets configured.</p>'
      return
    }

    targets.forEach((target) => {
      elements.targetsRoot.appendChild(renderTargetCard(target))
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
      row.innerHTML = `
        <td>${formatLogTime(entry.createdAt)}</td>
        <td><code class="small">${entry.eventType ?? '—'}</code></td>
        <td><span class="small">${entry.targetType ?? '—'}</span> <span class="admin-muted small">${entry.targetId ?? ''}</span></td>
        <td><span class="${statusClass}">${entry.status ?? '—'}</span></td>
        <td class="small text-break">${entry.errorSnippet ?? '—'}</td>
      `
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
    elements.targetsRoot.appendChild(renderTargetCard(createEmptyTarget()))
  })

  elements.logRefresh?.addEventListener('click', () => {
    void loadDeliveryLog(true)
  })

  elements.logMore?.addEventListener('click', () => {
    logLimit = Math.min(logLimit + 25, 200)
    void loadDeliveryLog(false)
  })

  window.__ADMIN_NOTIFICATIONS__ = {
    load: loadNotifications,
  }
})()
