import { timingSafeEqual } from 'crypto'

import { always, applySpec, ifElse, is, path, prop, propEq, propSatisfies } from 'ramda'
import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { fromNodelessInvoice } from '../../utils/transform'
import { hmacSha256 } from '../../utils/secret'
import { IController } from '../../@types/controllers'
import { IPaymentsService } from '../../@types/services'
import { nodelessCallbackBodySchema, nodelessSignatureSchema } from '../../schemas/nodeless-callback-schema'
import { validateSchema } from '../../utils/validation'

const logger = createLogger('nodeless-callback-controller')

export class NodelessCallbackController implements IController {
  public constructor(private readonly paymentsService: IPaymentsService) {}

  public async handleRequest(request: Request, response: Response) {
    logger('callback request headers: %o', request.headers)
    logger('callback request body: %O', request.body)

    const bodyValidation = validateSchema(nodelessCallbackBodySchema)(request.body)
    if (bodyValidation.error) {
      logger('nodeless callback request rejected: invalid body %o', bodyValidation.error)
      response
        .status(400)
        .setHeader('content-type', 'application/json; charset=utf8')
        .send('{"status":"error","message":"Malformed body"}')
      return
    }

    const webhookSecret = process.env.NODELESS_WEBHOOK_SECRET
    if (!webhookSecret) {
      logger.error('NODELESS_WEBHOOK_SECRET is not configured; unable to verify Nodeless callback')
      response
        .status(500)
        .setHeader('content-type', 'application/json; charset=utf8')
        .send('{"status":"error","message":"Internal Server Error"}')
      return
    }

    const signatureValidation = validateSchema(nodelessSignatureSchema)(request.headers['nodeless-signature'])
    if (signatureValidation.error) {
      logger('nodeless callback request rejected: invalid signature format')
      response
        .status(400)
        .setHeader('content-type', 'application/json; charset=utf8')
        .send('{"status":"error","message":"Invalid signature"}')
      return
    }

    const expectedBuf = hmacSha256(webhookSecret, (request as any).rawBody)
    const actualBuf = Buffer.from(signatureValidation.value, 'hex')

    if (!timingSafeEqual(expectedBuf, actualBuf)) {
      logger('nodeless callback request rejected: signature mismatch')
      response.status(403).send('Forbidden')
      return
    }

    const nodelessInvoice = applySpec({
      id: prop('uuid'),
      status: prop('status'),
      satsAmount: prop('amount'),
      metadata: prop('metadata'),
      paidAt: ifElse(propEq('status', 'paid'), always(new Date().toISOString()), always(null)),
      createdAt: ifElse(propSatisfies(is(String), 'createdAt'), prop('createdAt'), path(['metadata', 'createdAt'])),
    })(request.body)

    logger('nodeless invoice: %O', nodelessInvoice)

    const invoice = fromNodelessInvoice(nodelessInvoice)

    logger('invoice: %O', invoice)

    let updatedInvoice: Invoice
    try {
      updatedInvoice = await this.paymentsService.updateInvoiceStatus(invoice)
      logger('updated invoice: %O', updatedInvoice)
    } catch (error) {
      logger.error(`Unable to persist invoice ${invoice.id}`, error)

      throw error
    }

    if (updatedInvoice.status !== InvoiceStatus.COMPLETED && !updatedInvoice.confirmedAt) {
      response.status(200).send()

      return
    }

    invoice.amountPaid = invoice.amountRequested
    updatedInvoice.amountPaid = invoice.amountRequested

    try {
      await this.paymentsService.confirmInvoice(invoice)
      await this.paymentsService.sendInvoiceUpdateNotification(updatedInvoice)
    } catch (error) {
      logger.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response.status(200).setHeader('content-type', 'application/json; charset=utf8').send('{"status":"ok"}')
  }
}
