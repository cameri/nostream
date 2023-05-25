import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { fromZebedeeInvoice } from '../../utils/transform'
import { getRemoteAddress } from '../../utils/http'
import { IController } from '../../@types/controllers'
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
    debug('request body: %O', request.body)

    const settings = createSettings()

    const { ipWhitelist = [] } = settings.paymentsProcessors?.zebedee ?? {}
    const remoteAddress = getRemoteAddress(request, settings)
    const paymentProcessor = settings.payments?.processor

    if (ipWhitelist.length && !ipWhitelist.includes(remoteAddress)) {
      debug('unauthorized request from %s to /callbacks/zebedee', remoteAddress)
      response
        .status(403)
        .send('Forbidden')
      return
    }

    if (paymentProcessor !== 'zebedee') {
      debug('denied request from %s to /callbacks/zebedee which is not the current payment processor', remoteAddress)
      response
        .status(403)
        .send('Forbidden')
      return
    }

    const invoice = fromZebedeeInvoice(request.body)

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
    invoice.status = updatedInvoice.status
    updatedInvoice.amountPaid = invoice.amountRequested

    try {
      await this.paymentsService.confirmInvoice({
        id: invoice.id,
        pubkey: invoice.pubkey,
        status: invoice.status,
        confirmedAt: invoice.confirmedAt,
        amountPaid: invoice.amountRequested,
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
