import { Request, Response } from 'express'
import debug from 'debug'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { IController } from '../../@types/controllers'
import { IPaymentsService } from '../../@types/services'

export abstract class CallbackHandler implements IController {
  protected constructor(
    protected readonly debug: debug.Debugger,
    protected readonly paymentsService: IPaymentsService,
  ) {}

  // TODO: Validate
  public async handleRequest(
    request: Request,
    response: Response,
  ) {
    this.debug('request headers: %o', request.headers)
    this.debug('request body: %O', request.body)

    const invoice = await this.parseInvoice(request.body)

    this.debug('invoice', invoice)

    try {
      if (!invoice.bolt11) {
        await this.paymentsService.updateInvoice(invoice)
      }
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

  protected abstract parseInvoice(body: any): Promise<Invoice>
}
