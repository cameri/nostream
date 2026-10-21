(() => {
  const config = window.__ADMIN_DASHBOARD__ || { pathPrefix: '' }
  const adminBase = `${config.pathPrefix || ''}/admin`

  const auditBody = document.getElementById('trust-audit-body')
  if (!auditBody) {
    return
  }

  const elements = {
    auditSync: document.getElementById('trust-audit-sync'),
    auditRefresh: document.getElementById('trust-audit-refresh'),
    auditBody,
    diagnosticsDownload: document.getElementById('trust-diagnostics-download'),
    diagnosticsPreviewButton: document.getElementById('trust-diagnostics-preview-button'),
    diagnosticsPreviewWrap: document.getElementById('trust-diagnostics-preview-wrap'),
    diagnosticsPreviewClose: document.getElementById('trust-diagnostics-preview-close'),
    diagnosticsPreviewPlaceholder: document.getElementById('trust-diagnostics-preview-placeholder'),
    diagnosticsPreviewBody: document.getElementById('trust-diagnostics-preview-body'),
    diagnosticsStatus: document.getElementById('trust-diagnostics-status'),
    error: document.getElementById('trust-error'),
  }

  const escapeHtml = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')

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

  const showError = (message) => {
    if (!elements.error) {
      return
    }
    elements.error.textContent = message
    elements.error.classList.remove('d-none')
  }

  const hideError = () => {
    elements.error?.classList.add('d-none')
  }

  const renderAuditEntries = (entries) => {
    elements.auditBody.replaceChildren()
    if (!Array.isArray(entries) || entries.length === 0) {
      elements.auditBody.innerHTML = '<tr><td colspan="4" class="admin-muted small">No audit entries yet.</td></tr>'
      return
    }

    entries.forEach((entry) => {
      const row = document.createElement('tr')
      const detail =
        entry.detail && Object.keys(entry.detail).length > 0
          ? `<code class="small">${escapeHtml(JSON.stringify(entry.detail))}</code>`
          : '—'
      row.innerHTML = `
        <td>${escapeHtml(formatTime(entry.at))}</td>
        <td><code>${escapeHtml(entry.action ?? '')}</code></td>
        <td>${escapeHtml(entry.remoteAddress ?? '—')}</td>
        <td>${detail}</td>
      `
      elements.auditBody.appendChild(row)
    })
  }

  const loadAuditLog = async () => {
    hideError()
    if (elements.auditSync) {
      elements.auditSync.textContent = '> audit: loading…'
    }

    try {
      const response = await adminFetch('/audit-log?limit=100')
      if (!response.ok) {
        showError('Failed to load audit log')
        if (elements.auditSync) {
          elements.auditSync.textContent = '> audit: load failed'
        }
        return
      }

      const body = await response.json()
      renderAuditEntries(body.entries ?? [])
      if (elements.auditSync) {
        elements.auditSync.textContent = `> audit: ${body.entries?.length ?? 0} entries`
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        globalThis.dispatchEvent(new CustomEvent('admin-unauthorized'))
        return
      }
      showError('Network error while loading audit log')
    }
  }

  const downloadDiagnostics = async () => {
    hideError()
    if (elements.diagnosticsStatus) {
      elements.diagnosticsStatus.textContent = 'Preparing export…'
    }

    try {
      const response = await adminFetch('/diagnostics/export?download=1')
      if (!response.ok) {
        showError('Diagnostics export failed')
        return
      }

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `nostream-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      if (elements.diagnosticsStatus) {
        elements.diagnosticsStatus.textContent = 'Download started (secrets redacted).'
      }
    } catch {
      showError('Network error during diagnostics export')
    }
  }

  const closeDiagnosticsPreview = () => {
    elements.diagnosticsPreviewWrap?.classList.add('d-none')
    elements.diagnosticsPreviewPlaceholder?.classList.remove('d-none')
    if (elements.diagnosticsPreviewBody) {
      elements.diagnosticsPreviewBody.textContent = ''
    }
    if (elements.diagnosticsStatus) {
      elements.diagnosticsStatus.innerHTML =
        '<span class="prompt-char">&gt;</span> diagnostics: idle'
    }
  }

  const showDiagnosticsPreview = (payload) => {
    elements.diagnosticsPreviewPlaceholder?.classList.add('d-none')
    elements.diagnosticsPreviewWrap?.classList.remove('d-none')
    if (elements.diagnosticsPreviewBody) {
      elements.diagnosticsPreviewBody.textContent = JSON.stringify(payload, null, 2)
    }
    if (elements.diagnosticsStatus) {
      elements.diagnosticsStatus.textContent = `Generated ${payload.generatedAt ?? ''} · version ${payload.version ?? 'unknown'}`
    }
  }

  const previewDiagnostics = async () => {
    hideError()
    if (elements.diagnosticsStatus) {
      elements.diagnosticsStatus.textContent = 'Loading preview…'
    }

    try {
      const response = await adminFetch('/diagnostics/export')
      if (!response.ok) {
        showError('Diagnostics preview failed')
        return
      }

      const payload = await response.json()
      showDiagnosticsPreview(payload)
    } catch {
      showError('Network error during diagnostics preview')
    }
  }

  elements.auditRefresh?.addEventListener('click', () => {
    void loadAuditLog()
  })
  elements.diagnosticsDownload?.addEventListener('click', () => {
    void downloadDiagnostics()
  })
  elements.diagnosticsPreviewButton?.addEventListener('click', () => {
    void previewDiagnostics()
  })
  elements.diagnosticsPreviewClose?.addEventListener('click', () => {
    closeDiagnosticsPreview()
  })

  window.__ADMIN_TRUST__ = {
    load: loadAuditLog,
    closeDiagnosticsPreview,
  }
})()
