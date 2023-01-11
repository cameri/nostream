import { Router, urlencoded } from 'express'

import { getInvoiceRequestHandler } from '../../handlers/request-handlers/get-invoice-request-handler'
import { postInvoiceRequestHandler } from '../../handlers/request-handlers/post-invoice-request-handler'

const invoiceRouter = Router()

invoiceRouter.get('/', getInvoiceRequestHandler)
invoiceRouter.post('/', urlencoded({ extended: true }), postInvoiceRequestHandler)

export default invoiceRouter
