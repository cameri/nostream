const DEFAULT_GRAFANA_URL = 'http://127.0.0.1:3000'
const DEFAULT_DASHBOARD_UID = 'nostream-overview'

export const getGrafanaBaseUrl = (): string => {
  const configured = process.env.GRAFANA_URL?.trim()
  if (!configured) {
    return DEFAULT_GRAFANA_URL
  }

  return configured.replace(/\/+$/, '')
}

export const getGrafanaDashboardUid = (): string => {
  const configured = process.env.GRAFANA_DASHBOARD_UID?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_DASHBOARD_UID
}

export const getGrafanaDashboardUrl = (): string => {
  const baseUrl = getGrafanaBaseUrl()
  const dashboardUid = getGrafanaDashboardUid()

  return `${baseUrl}/d/${dashboardUid}/nostream-overview?orgId=1&refresh=5s&theme=light`
}

export const getGrafanaSoloPanelUrl = (panelId: number | string, theme: 'light' | 'dark' = 'light'): string => {
  const baseUrl = getGrafanaBaseUrl()
  const dashboardUid = getGrafanaDashboardUid()
  const params = new URLSearchParams({
    orgId: '1',
    panelId: String(panelId),
    refresh: '5s',
    theme,
  })

  return `${baseUrl}/d-solo/${dashboardUid}?${params.toString()}`
}

export const getGrafanaEmbedUrl = (): string => {
  return `${getGrafanaDashboardUrl()}&kiosk`
}

export const getGrafanaFrameOrigin = (): string => {
  try {
    return new URL(getGrafanaBaseUrl()).origin
  } catch {
    return new URL(DEFAULT_GRAFANA_URL).origin
  }
}
