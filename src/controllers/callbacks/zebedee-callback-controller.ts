import { Request, Response } from 'express'

import { createLogger } from '../../factories/logger-factory'
import { fromZebedeeInvoice } from '../../utils/transform'
import { IController } from '../../@types/controllers'
import { InvoiceStatus } from '../../@types/invoice'
import { IPaymentsService } from '../../@types/services'

const debug = createLogger('zebedee-callback-controller')

export class ZebedeeCallbackController implements IController {
  public constructor(
    private readonly paymentsService: IPaymentsService,
  ) {}

  // TODO: Validate
  public async handleRequest(
    request: Request,
    response: Response,
  ) {
    debug('request headers: %o', request.headers)
    debug('request body: %o', request.body)

    const invoice = fromZebedeeInvoice(request.body)

    debug('invoice', invoice)

    try {
      await this.paymentsService.updateInvoice(invoice)
    } catch (error) {
      console.error(`Unable to persist invoice ${invoice.id}`, error)

      throw error
    }

    if (
      invoice.status !== InvoiceStatus.COMPLETED
      && !invoice.confirmedAt
    ) {
      response
        .status(200)
        .send()

      return
    }

    invoice.amountPaid = invoice.amountRequested

    try {
      await this.paymentsService.confirmInvoice(invoice)
      await this.paymentsService.sendInvoiceUpdateNotification(invoice)
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
