import { NextFunction, Request, Response } from 'express'

import { createAdminAuthProvider } from '../../factories/admin-auth-provider-factory'
import { createSettings } from '../../factories/settings-factory'
import { getPublicPathPrefix } from '../../utils/http'

const adminAuthProvider = createAdminAuthProvider()

const isHtmlNavigation = (request: Request): boolean => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false
  }

  const accept = request.headers.accept

  return typeof accept === 'string' && accept.includes('text/html')
}

export const adminAuthMiddleware = async (request: Request, response: Response, next: NextFunction) => {
  try {
    if (!(await adminAuthProvider.isRequestAuthenticated(request))) {
      if (isHtmlNavigation(request)) {
        response.redirect(302, `${getPublicPathPrefix(request, createSettings())}/admin/login`)
        return
      }

      response.status(401).setHeader('content-type', 'application/json').send({ error: 'Unauthorized' })
      return
    }
  } catch {
    response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
    return
  }

  next()
}
