import { NextFunction, Request, Response } from 'express'
import { readFileSync } from 'fs'

import { createSettings as settings } from '../../factories/settings-factory'



export const getTermsRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  const { info: { name } } = settings()

  let page: string
  try {
    page = readFileSync('./resources/terms.html', 'utf8')
      .replaceAll('{{name}}', name)
      .replaceAll('{{nonce}}', res.locals.nonce)
  } catch (err) {
    next(err)
    return
  }

  res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(page)
}
