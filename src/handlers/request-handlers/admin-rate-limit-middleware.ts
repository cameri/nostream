import { NextFunction, Request, Response } from 'express'

import { createSettings } from '../../factories/settings-factory'
import { rateLimiterFactory } from '../../factories/rate-limiter-factory'
import { isAdminRateLimited } from '../../utils/admin-rate-limit'

type AdminRateLimitScope = 'login' | 'admin'

const sendTooManyRequests = (response: Response) => {
  response.status(429).setHeader('content-type', 'application/json').send({ error: 'Too many requests' })
}

export const createAdminRateLimitMiddleware = (scope: AdminRateLimitScope) => {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (await isAdminRateLimited(request, createSettings(), rateLimiterFactory, scope)) {
      sendTooManyRequests(response)
      return
    }

    next()
  }
}

export const adminLoginRateLimitMiddleware = createAdminRateLimitMiddleware('login')
export const adminRateLimitMiddleware = createAdminRateLimitMiddleware('admin')
