import { Router, urlencoded } from 'express'
import { createPaymentsProcessor } from '../../factories/payments-processor-factory'

import { getInvoiceRequestHandler } from '../../handlers/request-handlers/get-invoice-request-handler'
import { postInvoiceRequestHandler } from '../../handlers/request-handlers/post-invoice-request-handler'

const invoiceRouter = Router()

invoiceRouter
    .use((req, _res, next) => {
      req['paymentsProcessor'] = createPaymentsProcessor()
      next()
    })
  .get('/', getInvoiceRequestHandler)
  .post('/', urlencoded({ extended: true }), postInvoiceRequestHandler)

export default invoiceRouter
