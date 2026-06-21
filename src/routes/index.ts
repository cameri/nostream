import express, { Router } from 'express'

import { nodeinfo21Handler, nodeinfoHandler } from '../handlers/request-handlers/nodeinfo-handler'
import admissionRouter from './admissions'
import callbacksRouter from './callbacks'
import { getHealthRequestHandler } from '../handlers/request-handlers/get-health-request-handler'
import { getPrivacyRequestHandler } from '../handlers/request-handlers/get-privacy-request-handler'
import { getTermsRequestHandler } from '../handlers/request-handlers/get-terms-request-handler'
import invoiceRouter from './invoices'
import { rateLimiterMiddleware } from '../handlers/request-handlers/rate-limiter-middleware'
import { hasExplicitNostrJsonAcceptHeader, rootRequestHandler } from '../handlers/request-handlers/root-request-handler'

const router: Router = express.Router()

router.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/' && hasExplicitNostrJsonAcceptHeader(req)) {
    return rootRequestHandler(req, res, next)
  }
  next()
})

router.get('/', rootRequestHandler)
router.get('/healthz', getHealthRequestHandler)
router.get('/terms', getTermsRequestHandler)
router.get('/privacy', getPrivacyRequestHandler)

router.get('/.well-known/nodeinfo', nodeinfoHandler)
router.get('/nodeinfo/2.1', nodeinfo21Handler)
router.get('/nodeinfo/2.0', nodeinfo21Handler)

router.use('/invoices', rateLimiterMiddleware, invoiceRouter)
router.use('/admissions', rateLimiterMiddleware, admissionRouter)
router.use('/callbacks', rateLimiterMiddleware, callbacksRouter)

export default router
