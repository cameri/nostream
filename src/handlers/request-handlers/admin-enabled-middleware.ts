import { NextFunction, Request, Response } from 'express'

import { createSettings } from '../../factories/settings-factory'

export const adminEnabledMiddleware = (_request: Request, response: Response, next: NextFunction) => {
  if (!createSettings().admin?.enabled) {
    response.status(404).setHeader('content-type', 'text/plain').send('Not Found')
    return
  }

  next()
}
