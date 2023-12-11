import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { fromOpenNodeInvoice } from '../../utils/transform'
import { IController } from '../../@types/controllers'
import { IPaymentsService } from '../../@types/services'

const debug = createLogger('opennode-callback-controller')

export class OpenNodeCallbackController implements IController {
  public constructor(
    private readonly paymentsService: IPaymentsService,
  ) {}

  // TODO: Validate
  public async handleRequest(
    request: Request,
    response: Response,
  ) {
    debug('request headers: %o', request.headers)
    debug('request body: %O', request.body)

    const invoice = fromOpenNodeInvoice(request.body)

    debug('invoice', invoice)

    let updatedInvoice: Invoice
    try {
      updatedInvoice = await this.paymentsService.updateInvoiceStatus(invoice)
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
      await this.paymentsService.confirmInvoice({
        id: invoice.id,
        pubkey: invoice.pubkey,
        status: updatedInvoice.status,
        amountPaid: updatedInvoice.amountRequested,
        confirmedAt: updatedInvoice.confirmedAt,
      })
      await this.paymentsService.sendInvoiceUpdateNotification(updatedInvoice)
    } catch (error) {
      console.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response
      .status(200)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('OK')
  }
}
