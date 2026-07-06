import { expect } from 'chai'

import {
  getGrafanaBaseUrl,
  getGrafanaDashboardUid,
  getGrafanaDashboardUrl,
  getGrafanaEmbedUrl,
  getGrafanaFrameOrigin,
  getGrafanaSoloPanelUrl,
} from '../../../src/utils/admin-grafana'

describe('admin-grafana', () => {
  const originalGrafanaUrl = process.env.GRAFANA_URL
  const originalDashboardUid = process.env.GRAFANA_DASHBOARD_UID

  afterEach(() => {
    if (originalGrafanaUrl === undefined) {
      delete process.env.GRAFANA_URL
    } else {
      process.env.GRAFANA_URL = originalGrafanaUrl
    }

    if (originalDashboardUid === undefined) {
      delete process.env.GRAFANA_DASHBOARD_UID
    } else {
      process.env.GRAFANA_DASHBOARD_UID = originalDashboardUid
    }
  })

  it('uses defaults when env vars are unset', () => {
    delete process.env.GRAFANA_URL
    delete process.env.GRAFANA_DASHBOARD_UID

    expect(getGrafanaBaseUrl()).to.equal('http://127.0.0.1:3000')
    expect(getGrafanaDashboardUid()).to.equal('nostream-overview')
    expect(getGrafanaFrameOrigin()).to.equal('http://127.0.0.1:3000')
  })

  it('normalizes configured grafana url', () => {
    process.env.GRAFANA_URL = 'http://grafana.example.com/'

    expect(getGrafanaBaseUrl()).to.equal('http://grafana.example.com')
    expect(getGrafanaFrameOrigin()).to.equal('http://grafana.example.com')
  })

  it('builds dashboard and embed urls', () => {
    process.env.GRAFANA_URL = 'http://127.0.0.1:3000'
    process.env.GRAFANA_DASHBOARD_UID = 'custom-dashboard'

    expect(getGrafanaDashboardUrl()).to.equal(
      'http://127.0.0.1:3000/d/custom-dashboard/nostream-overview?orgId=1&refresh=5s&theme=light',
    )
    expect(getGrafanaEmbedUrl()).to.equal(
      'http://127.0.0.1:3000/d/custom-dashboard/nostream-overview?orgId=1&refresh=5s&theme=light&kiosk',
    )
    expect(getGrafanaSoloPanelUrl(7, 'dark')).to.equal(
      'http://127.0.0.1:3000/d-solo/custom-dashboard?orgId=1&panelId=7&refresh=5s&theme=dark',
    )
  })
})
