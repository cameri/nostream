import { NextFunction, Request, Response } from 'express'
import { readFileSync } from 'fs'

import { createSettings as settings } from '../../factories/settings-factory'

let pageCache: string

export const getTermsRequestHandler = (_req: Request, res: Response, next: NextFunction) => {
  const { info: { name } } = settings()

  if (!pageCache) {
    pageCache = readFileSync('./resources/terms.html', 'utf8').replaceAll('{{name}}', name)
  }

  res.status(200).setHeader('content-type', 'text/html; charset=utf8').send(pageCache)
  next()
}
