import express, { Router } from 'express'

import { nodeinfo21Handler, nodeinfoHandler } from '../handlers/request-handlers/nodeinfo-handler'
import adminRouter from './admin'
import admissionRouter from './admissions'
import callbacksRouter from './callbacks'
import { getHealthRequestHandler } from '../handlers/request-handlers/get-health-request-handler'
import { getPrivacyRequestHandler } from '../handlers/request-handlers/get-privacy-request-handler'
import { getReadyzRequestHandler } from '../handlers/request-handlers/get-readyz-request-handler'
import { getTermsRequestHandler } from '../handlers/request-handlers/get-terms-request-handler'
import invoiceRouter from './invoices'
import { rateLimiterMiddleware } from '../handlers/request-handlers/rate-limiter-middleware'
import { hasExplicitNostrJsonAcceptHeader, rootRequestHandler } from '../handlers/request-handlers/root-request-handler'

const router: Router = express.Router()

// Public NIP-11 / homepage — advertises relay metadata only; not an authentication endpoint.
router.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/' && hasExplicitNostrJsonAcceptHeader(req)) {
    return rootRequestHandler(req, res, next)
  }
  next()
})

router.get('/', rootRequestHandler)
// Liveness: process is running (always 200). Used for "is the container up?" checks.
router.get('/healthz', getHealthRequestHandler)
router.get('/privacy', getPrivacyRequestHandler)
// Readiness: Postgres + Redis must respond. Used before routing traffic during deploys.
router.get('/readyz', getReadyzRequestHandler)
router.get('/terms', getTermsRequestHandler)

router.get('/.well-known/nodeinfo', nodeinfoHandler)
router.get('/nodeinfo/2.1', nodeinfo21Handler)
router.get('/nodeinfo/2.0', nodeinfo21Handler)

router.use('/admin', adminRouter)
router.use('/invoices', rateLimiterMiddleware, invoiceRouter)
router.use('/admissions', rateLimiterMiddleware, admissionRouter)
router.use('/callbacks', rateLimiterMiddleware, callbacksRouter)

export default router
