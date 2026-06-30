import { NextFunction, Request, Response } from 'express'

import { createAdminAuthProvider } from '../../factories/admin-auth-provider-factory'

const adminAuthProvider = createAdminAuthProvider()

export const adminAuthMiddleware = (request: Request, response: Response, next: NextFunction) => {
  try {
    if (!adminAuthProvider.isRequestAuthenticated(request)) {
      response.status(401).setHeader('content-type', 'application/json').send({ error: 'Unauthorized' })
      return
    }
  } catch {
    response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
    return
  }

  next()
}
