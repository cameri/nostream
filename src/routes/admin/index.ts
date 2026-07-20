import express, { json, Router } from 'express'

import { createGetAdminHealthController } from '../../factories/controllers/get-admin-health-controller-factory'
import { createGetAdminMetricsController } from '../../factories/controllers/get-admin-metrics-controller-factory'
import { createGetAdminSessionController } from '../../factories/controllers/get-admin-session-controller-factory'
import { createGetAdminSettingsController } from '../../factories/controllers/get-admin-settings-controller-factory'
import { createGetAdminSettingsSchemaController } from '../../factories/controllers/get-admin-settings-schema-controller-factory'
import { createPatchAdminSettingsController } from '../../factories/controllers/patch-admin-settings-controller-factory'
import { createPostAdminLoginController } from '../../factories/controllers/post-admin-login-controller-factory'
import { createPostAdminLogoutController } from '../../factories/controllers/post-admin-logout-controller-factory'
import { createPostAdminSettingsValidateController } from '../../factories/controllers/post-admin-settings-validate-controller-factory'
import { adminAuthMiddleware } from '../../handlers/request-handlers/admin-auth-middleware'
import { adminEnabledMiddleware } from '../../handlers/request-handlers/admin-enabled-middleware'
import {
  adminLoginRateLimitMiddleware,
  adminRateLimitMiddleware,
} from '../../handlers/request-handlers/admin-rate-limit-middleware'
import { getAdminDashboardRequestHandler } from '../../handlers/request-handlers/get-admin-dashboard-request-handler'
import { rateLimiterMiddleware } from '../../handlers/request-handlers/rate-limiter-middleware'
import { withAdminController } from '../../handlers/request-handlers/with-admin-controller-request-handler'

const router: Router = Router()

// codeql[js/missing-rate-limiting] - custom Redis-backed sliding window rate limiter
router.use(rateLimiterMiddleware)
// codeql[js/missing-rate-limiting] - feature gate only, not authentication
router.use(adminEnabledMiddleware)
router.use('/assets', express.static('./resources/admin/assets'))
router.get('/', getAdminDashboardRequestHandler)
router.get('/dashboard', getAdminDashboardRequestHandler)
router.post('/login', adminLoginRateLimitMiddleware, json(), withAdminController(createPostAdminLoginController))
router.post('/logout', adminRateLimitMiddleware, withAdminController(createPostAdminLogoutController))
router.get('/session', adminRateLimitMiddleware, adminAuthMiddleware, withAdminController(createGetAdminSessionController))
router.get('/health', adminRateLimitMiddleware, adminAuthMiddleware, withAdminController(createGetAdminHealthController))
router.get('/metrics', adminRateLimitMiddleware, adminAuthMiddleware, withAdminController(createGetAdminMetricsController))
router.get('/settings', adminRateLimitMiddleware, adminAuthMiddleware, withAdminController(createGetAdminSettingsController))
router.get(
  '/settings/schema',
  adminRateLimitMiddleware,
  adminAuthMiddleware,
  withAdminController(createGetAdminSettingsSchemaController),
)
router.patch('/settings', adminRateLimitMiddleware, adminAuthMiddleware, json(), withAdminController(createPatchAdminSettingsController))
router.post(
  '/settings/validate',
  adminRateLimitMiddleware,
  adminAuthMiddleware,
  withAdminController(createPostAdminSettingsValidateController),
)

export default router
