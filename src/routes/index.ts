import express from 'express'

import callbacksRouter from './callbacks'
import { getHealthRequestHandler } from '../handlers/request-handlers/get-health-request-handler'
import { getTermsRequestHandler } from '../handlers/request-handlers/get-terms-request-handler'
import invoiceRouter from './invoices'
import { rootRequestHandler } from '../handlers/request-handlers/root-request-handler'

const router = express.Router()

router.get('/', rootRequestHandler)
router.get('/healthz', getHealthRequestHandler)
router.get('/terms', getTermsRequestHandler)

router.use('/invoices', invoiceRouter)
router.use('/callbacks', callbacksRouter)

export default router
