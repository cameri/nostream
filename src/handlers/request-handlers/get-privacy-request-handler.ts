import { NextFunction, Request, Response } from 'express'
import { readFileSync } from 'fs'

import { createSettings as settings } from '../../factories/settings-factory'

export const getPrivacyRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  const { info: { name } } = settings()

  const page = readFileSync('./resources/privacy.html', 'utf8')
    .replaceAll('{{name}}', name)
    .replaceAll('{{nonce}}', res.locals.nonce)

  res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
  next()
}
