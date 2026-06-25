import { NextFunction, Request, Response } from 'express'

import { createSettings } from '../../factories/settings-factory'
import { rateLimiterFactory } from '../../factories/rate-limiter-factory'
import { isAdminRateLimited } from '../../utils/admin-rate-limit'

const sendTooManyRequests = (response: Response) => {
  response.status(429).setHeader('content-type', 'application/json').send({ error: 'Too many requests' })
}

export const adminLoginRateLimitMiddleware = async (request: Request, response: Response, next: NextFunction) => {
  if (await isAdminRateLimited(request, createSettings(), rateLimiterFactory, 'login')) {
    sendTooManyRequests(response)
    return
  }

  next()
}

export const adminRateLimitMiddleware = async (request: Request, response: Response, next: NextFunction) => {
  if (await isAdminRateLimited(request, createSettings(), rateLimiterFactory, 'admin')) {
    sendTooManyRequests(response)
    return
  }

  next()
}
