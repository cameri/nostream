import { json, NextFunction, Request, Response, Router } from 'express'

import { createAdminAuthProvider } from '../../factories/admin-auth-provider-factory'
import { createGetAdminHealthController } from '../../factories/controllers/get-admin-health-controller-factory'
import { createGetAdminSessionController } from '../../factories/controllers/get-admin-session-controller-factory'
import { createPostAdminLoginController } from '../../factories/controllers/post-admin-login-controller-factory'
import { createSettings } from '../../factories/settings-factory'
import {
  adminLoginRateLimitMiddleware,
  adminRateLimitMiddleware,
} from '../../handlers/request-handlers/admin-rate-limit-middleware'
import { rateLimiterMiddleware } from '../../handlers/request-handlers/rate-limiter-middleware'
import { withController } from '../../handlers/request-handlers/with-controller-request-handler'

const router: Router = Router()

const requireAdminEnabled = (_request: Request, response: Response, next: NextFunction) => {
  const settings = createSettings()
  if (!settings.admin?.enabled) {
    response.status(404).setHeader('content-type', 'text/plain').send('Not Found')
    return
  }

  next()
}

const requireAdminAuth = (request: Request, response: Response, next: NextFunction) => {
  try {
    if (!createAdminAuthProvider().isRequestAuthenticated(request)) {
      response.status(401).setHeader('content-type', 'application/json').send({ error: 'Unauthorized' })
      return
    }
  } catch {
    response.status(500).setHeader('content-type', 'application/json').send({ error: 'Internal Server Error' })
    return
  }

  next()
}

router.use(requireAdminEnabled)
router.use(rateLimiterMiddleware)

router.post('/login', adminLoginRateLimitMiddleware, json(), withController(createPostAdminLoginController))
router.get('/session', adminRateLimitMiddleware, requireAdminAuth, withController(createGetAdminSessionController))
router.get('/health', adminRateLimitMiddleware, requireAdminAuth, withController(createGetAdminHealthController))

export default router
