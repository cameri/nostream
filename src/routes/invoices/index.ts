import { Router, urlencoded } from 'express'

import { createGetInvoiceController } from '../../factories/controllers/get-invoice-controller-factory'
import { createGetInvoiceStatusController } from '../../factories/controllers/get-invoice-status-controller-factory'
import { createPostInvoiceController } from '../../factories/controllers/post-invoice-controller-factory'
import { withController } from '../../handlers/request-handlers/with-controller-request-handler'

const invoiceRouter = Router()

invoiceRouter
  .get('/', withController(createGetInvoiceController))
  .get('/:invoiceId/status', withController(createGetInvoiceStatusController))
  .post('/', urlencoded({ extended: true }), withController(createPostInvoiceController))

export default invoiceRouter