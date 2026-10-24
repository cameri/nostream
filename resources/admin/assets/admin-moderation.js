(() => {
  const config = window.__ADMIN_DASHBOARD__ || { pathPrefix: '' }
  const adminBase = `${config.pathPrefix || ''}/admin`

  const syncLine = document.getElementById('moderation-sync')
  if (!syncLine) {
    return
  }

  const elements = {
    error: document.getElementById('moderation-error'),
    success: document.getElementById('moderation-success'),
    syncLine,
    banPubkeyInput: document.getElementById('moderation-ban-pubkey'),
    ipInput: document.getElementById('moderation-ip'),
    banButton: document.getElementById('moderation-ban-button'),
    unbanButton: document.getElementById('moderation-unban-button'),
    whitelistIpButton: document.getElementById('moderation-whitelist-ip-button'),
    unwhitelistIpButton: document.getElementById('moderation-unwhitelist-ip-button'),
    refreshButton: document.getElementById('moderation-refresh-button'),
    topPubkeysBody: document.getElementById('moderation-top-pubkeys-body'),
    topIpsBody: document.getElementById('moderation-top-ips-body'),
    ratePubkeysBody: document.getElementById('moderation-rate-pubkeys-body'),
    pubkeyBlacklist: document.getElementById('moderation-pubkey-blacklist'),
    pubkeyWhitelist: document.getElementById('moderation-pubkey-whitelist'),
    kindBlacklist: document.getElementById('moderation-kind-blacklist'),
    kindWhitelist: document.getElementById('moderation-kind-whitelist'),
    bypassPubkeys: document.getElementById('moderation-bypass-pubkeys'),
    bypassIps: document.getElementById('moderation-bypass-ips'),
  }

  const escapeHtml = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')

  const adminFetch = async (path, options = {}) => {
    const response = await fetch(`${adminBase}${path}`, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options,
    })
    if (response.status === 401) {
      throw new Error('Unauthorized')
    }
    return response
  }

  const showError = (message) => {
    elements.error.textContent = message
    elements.error.classList.remove('d-none')
    elements.success.classList.add('d-none')
  }

  const showSuccess = (message) => {
    elements.success.textContent = message
    elements.success.classList.remove('d-none')
    elements.error.classList.add('d-none')
  }

  const hideMessages = () => {
    elements.error.classList.add('d-none')
    elements.success.classList.add('d-none')
  }

  const handleUnauthorized = () => {
    globalThis.dispatchEvent(new CustomEvent('admin-unauthorized'))
  }

  const renderRows = (body, rows, keyField, valueField, emptyLabel) => {
    if (!body) {
      return
    }
    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = `<tr><td colspan="2" class="admin-muted small">${escapeHtml(emptyLabel)}</td></tr>`
      return
    }
    body.innerHTML = rows
      .map(
        (row) =>
          `<tr><td><code class="small">${escapeHtml(row[keyField])}</code></td><td>${escapeHtml(row[valueField])}</td></tr>`,
      )
      .join('')
  }

  const renderRateRows = (body, rows) => {
    if (!body) {
      return
    }
    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = '<tr><td colspan="2" class="admin-muted small">No rate-limit hits recorded yet.</td></tr>'
      return
    }
    body.innerHTML = rows
      .map((row) => `<tr><td><code class="small">${escapeHtml(row.key)}</code></td><td>${escapeHtml(row.hits)}</td></tr>`)
      .join('')
  }

  const renderLimits = (limits) => {
    const pretty = (value) => JSON.stringify(value ?? [], null, 2)
    elements.pubkeyBlacklist.textContent = pretty(limits.pubkey?.blacklist)
    elements.pubkeyWhitelist.textContent = pretty(limits.pubkey?.whitelist)
    elements.kindBlacklist.textContent = pretty(limits.kind?.blacklist)
    elements.kindWhitelist.textContent = pretty(limits.kind?.whitelist)
    elements.bypassPubkeys.textContent = pretty(limits.rateLimitBypass?.pubkeys)
    elements.bypassIps.textContent = pretty(limits.rateLimitBypass?.ipAddresses)
  }

  const load = async () => {
    hideMessages()
    try {
      const [limitsResponse, statsResponse] = await Promise.all([
        adminFetch('/moderation/limits'),
        adminFetch('/moderation/stats?windowHours=168&limit=15'),
      ])

      if (!limitsResponse.ok || !statsResponse.ok) {
        throw new Error('Failed to load moderation data')
      }

      const limitsPayload = await limitsResponse.json()
      const statsPayload = await statsResponse.json()
      renderLimits(limitsPayload.limits)
      renderRows(elements.topPubkeysBody, statsPayload.topPublishingPubkeys, 'pubkey', 'eventCount', 'No events in window.')
      renderRows(elements.topIpsBody, statsPayload.topClientIps, 'ip', 'eventCount', 'No client IPs in window.')
      renderRateRows(elements.ratePubkeysBody, statsPayload.rateLimitHits?.pubkeys)
      elements.syncLine.innerHTML = `<span class="prompt-char">&gt;</span> moderation: updated ${new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        handleUnauthorized()
        return
      }
      showError('Unable to load moderation data.')
    }
  }

  const postAction = async (body) => {
    hideMessages()
    const response = await adminFetch('/moderation/actions', { method: 'POST', body: JSON.stringify(body) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload.error || 'Moderation action failed')
    }
    renderLimits(payload.limits)
    showSuccess('Limits updated.')
    elements.syncLine.innerHTML = `<span class="prompt-char">&gt;</span> moderation: action ${body.action} applied`
    void load()
  }

  const bindAction = (button, handler) => {
    button?.addEventListener('click', () => {
      void handler().catch((error) => {
        if (error instanceof Error && error.message === 'Unauthorized') {
          handleUnauthorized()
          return
        }
        showError(error instanceof Error ? error.message : 'Action failed.')
      })
    })
  }

  bindAction(elements.banButton, async () => {
    const pubkey = elements.banPubkeyInput?.value?.trim()
    if (!pubkey) {
      throw new Error('Enter a pubkey or npub to ban.')
    }
    await postAction({ action: 'ban-pubkey', pubkey })
  })

  bindAction(elements.unbanButton, async () => {
    const pubkey = elements.banPubkeyInput?.value?.trim()
    if (!pubkey) {
      throw new Error('Enter a pubkey or npub to unban.')
    }
    await postAction({ action: 'unban-pubkey', pubkey })
  })

  bindAction(elements.whitelistIpButton, async () => {
    const ip = elements.ipInput?.value?.trim()
    if (!ip) {
      throw new Error('Enter an IP address.')
    }
    await postAction({ action: 'whitelist-ip', ip })
  })

  bindAction(elements.unwhitelistIpButton, async () => {
    const ip = elements.ipInput?.value?.trim()
    if (!ip) {
      throw new Error('Enter an IP address.')
    }
    await postAction({ action: 'unwhitelist-ip', ip })
  })

  elements.refreshButton?.addEventListener('click', () => {
    void load()
  })

  window.__ADMIN_MODERATION__ = { load }
})()
