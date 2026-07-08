import { raw, Router } from 'express'

import { createGetAdminHealthController } from '../../factories/controllers/get-admin-health-controller-factory'
import { createGetAdminSessionController } from '../../factories/controllers/get-admin-session-controller-factory'
import { createPostAdminLoginController } from '../../factories/controllers/post-admin-login-controller-factory'
import { adminAuthMiddleware } from '../../handlers/request-handlers/admin-auth-middleware'
import { adminEnabledMiddleware } from '../../handlers/request-handlers/admin-enabled-middleware'
import {
  adminLoginRateLimitMiddleware,
  adminRateLimitMiddleware,
} from '../../handlers/request-handlers/admin-rate-limit-middleware'
import { getAdminDashboardPageHandler } from '../../handlers/request-handlers/get-admin-dashboard-page-handler'
import { getAdminLoginPageHandler } from '../../handlers/request-handlers/get-admin-login-page-handler'
import { postAdminLogoutHandler } from '../../handlers/request-handlers/post-admin-logout-handler'
import { rateLimiterMiddleware } from '../../handlers/request-handlers/rate-limiter-middleware'
import { withAdminController } from '../../handlers/request-handlers/with-admin-controller-request-handler'

const router: Router = Router()

// codeql[js/missing-rate-limiting] - custom Redis-backed sliding window rate limiter
router.use(rateLimiterMiddleware)
// codeql[js/missing-rate-limiting] - feature gate only, not authentication
router.use(adminEnabledMiddleware)
router.get('/login', adminLoginRateLimitMiddleware, getAdminLoginPageHandler)
router.post('/login', adminLoginRateLimitMiddleware, raw({ type: () => true, limit: '64kb' }), withAdminController(createPostAdminLoginController))
// Everything below requires NIP-98 authentication; unauthenticated browser
// navigations are redirected to the login page, other requests receive 401.
router.use(adminRateLimitMiddleware, adminAuthMiddleware)
router.get('/', getAdminDashboardPageHandler)
router.get('/session', withAdminController(createGetAdminSessionController))
router.get('/health', withAdminController(createGetAdminHealthController))
router.post('/logout', postAdminLogoutHandler)

export default router
