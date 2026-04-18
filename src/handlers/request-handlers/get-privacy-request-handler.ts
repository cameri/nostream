import { NextFunction, Request, Response } from 'express'

import { createSettings as settings } from '../../factories/settings-factory'

import { escapeHtml } from '../../utils/html'

import { getTemplate } from '../../utils/template-cache'

export const getPrivacyRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  const { info: { name } } = settings()

  let page: string
  try {
    page = getTemplate('./resources/privacy.html')
      .replaceAll('{{name}}', escapeHtml(name))
      .replaceAll('{{nonce}}', res.locals.nonce)
  } catch (err) {
    next(err)
    return
  }

  res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
}
