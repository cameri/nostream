import { NextFunction, Request, Response } from 'express'

import { createSettings as settings } from '../../factories/settings-factory'
import { getGrafanaBaseUrl, getGrafanaDashboardUid, getGrafanaDashboardUrl, getGrafanaEmbedUrl } from '../../utils/admin-grafana'
import { escapeHtml } from '../../utils/html'
import { getPublicPathPrefix } from '../../utils/http'
import { getTemplate } from '../../utils/template-cache'

export const getAdminDashboardRequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const currentSettings = settings()
  const {
    info: { name },
  } = currentSettings

  let page: string
  try {
    page = getTemplate('./resources/admin/dashboard.html')
      .replaceAll('{{name}}', escapeHtml(name))
      .replaceAll('{{path_prefix}}', escapeHtml(getPublicPathPrefix(req, currentSettings)))
      .replaceAll('{{grafana_embed_url}}', escapeHtml(getGrafanaEmbedUrl()))
      .replaceAll('{{grafana_url}}', escapeHtml(getGrafanaDashboardUrl()))
      .replaceAll('{{grafana_base_url}}', escapeHtml(getGrafanaBaseUrl()))
      .replaceAll('{{grafana_dashboard_uid}}', escapeHtml(getGrafanaDashboardUid()))
      .replaceAll('{{nonce}}', res.locals.nonce)
  } catch (err) {
    next(err)
    return
  }

  res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
}
