import { NextFunction, Request, Response } from 'express'

import { createSettings as settings } from '../../factories/settings-factory'
import { escapeHtml } from '../../utils/html'
import { getPublicPathPrefix } from '../../utils/http'
import { getTemplate } from '../../utils/template-cache'

export const getAdminDashboardPageHandler = (req: Request, res: Response, next: NextFunction) => {
  const currentSettings = settings()

  let page: string
  try {
    page = getTemplate('./resources/admin-dashboard.html')
      .replaceAll('{{name}}', escapeHtml(currentSettings.info.name))
      .replaceAll('{{path_prefix}}', escapeHtml(getPublicPathPrefix(req, currentSettings)))
      .replaceAll('{{nonce}}', res.locals.nonce ?? '')
  } catch (err) {
    next(err)
    return
  }

  res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
}
