import express from 'express'

import admissionRouter from './admissions'
import callbacksRouter from './callbacks'
import { getHealthRequestHandler } from '../handlers/request-handlers/get-health-request-handler'
import { getTermsRequestHandler } from '../handlers/request-handlers/get-terms-request-handler'
import invoiceRouter from './invoices'
import { rateLimiterMiddleware } from '../handlers/request-handlers/rate-limiter-middleware'
import { rootRequestHandler } from '../handlers/request-handlers/root-request-handler'

const router = express.Router()

router.get('/', rootRequestHandler)
router.get('/healthz', getHealthRequestHandler)
router.get('/terms', getTermsRequestHandler)

router.use('/invoices', rateLimiterMiddleware, invoiceRouter)
router.use('/admissions', rateLimiterMiddleware, admissionRouter)
router.use('/callbacks', rateLimiterMiddleware, callbacksRouter)

export default router
