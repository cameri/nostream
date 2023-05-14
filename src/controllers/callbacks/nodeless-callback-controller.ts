import { always, applySpec, ifElse, is, path, prop, propEq, propSatisfies } from 'ramda'
import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { fromNodelessInvoice } from '../../utils/transform'
import { IController } from '../../@types/controllers'
import { IPaymentsService } from '../../@types/services'

const debug = createLogger('nodeless-callback-controller')

export class NodelessCallbackController implements IController {
  public constructor(
    private readonly paymentsService: IPaymentsService,
  ) {}

  // TODO: Validate
  public async handleRequest(
    request: Request,
    response: Response,
  ) {
    debug('callback request headers: %o', request.headers)
    debug('callback request body: %O', request.body)

    const nodelessInvoice = applySpec({
      id: prop('uuid'),
      status: prop('status'),
      satsAmount: prop('amount'),
      metadata: prop('metadata'),
      paidAt: ifElse(
        propEq('status', 'paid'),
        always(new Date().toISOString()),
        always(null),
      ),
      createdAt: ifElse(
        propSatisfies(is(String), 'createdAt'),
        prop('createdAt'),
        path(['metadata', 'createdAt']),
      ),
    })(request.body)

    debug('nodeless invoice: %O', nodelessInvoice)

    const invoice = fromNodelessInvoice(nodelessInvoice)

    debug('invoice: %O', invoice)

    let updatedInvoice: Invoice
    try {
      updatedInvoice = await this.paymentsService.updateInvoiceStatus(invoice)
      debug('updated invoice: %O', updatedInvoice)
    } catch (error) {
      console.error(`Unable to persist invoice ${invoice.id}`, error)

      throw error
    }

    if (
      updatedInvoice.status !== InvoiceStatus.COMPLETED
      && !updatedInvoice.confirmedAt
    ) {
      response
        .status(200)
        .send()

      return
    }

    invoice.amountPaid = invoice.amountRequested
    updatedInvoice.amountPaid = invoice.amountRequested

    try {
      await this.paymentsService.confirmInvoice(invoice)
      await this.paymentsService.sendInvoiceUpdateNotification(updatedInvoice)
    } catch (error) {
      console.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response
      .status(200)
      .setHeader('content-type', 'application/json; charset=utf8')
      .send('{"status":"ok"}')
  }
}
