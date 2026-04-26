import { NextFunction, Request, Response } from 'express'
import { escapeHtml } from '../../utils/html'
import { getPublicPathPrefix } from '../../utils/http'
import { getTemplate } from '../../utils/template-cache'
import { createSettings as settings } from '../../factories/settings-factory'

export const getTermsRequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const currentSettings = settings()
  const {
    info: { name },
  } = currentSettings

  let page: string
  try {
    page = getTemplate('./resources/terms.html')
      .replaceAll('{{name}}', escapeHtml(name))
      .replaceAll('{{path_prefix}}', escapeHtml(getPublicPathPrefix(req, currentSettings)))
      .replaceAll('{{nonce}}', res.locals.nonce)
  } catch (err) {
    next(err)
    return
  }

  res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
}
