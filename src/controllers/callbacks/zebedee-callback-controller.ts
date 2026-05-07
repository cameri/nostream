import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { fromZebedeeInvoice } from '../../utils/transform'
import { getRemoteAddress } from '../../utils/http'
import { IController } from '../../@types/controllers'
import { IPaymentsService } from '../../@types/services'
import { validateSchema } from '../../utils/validation'
import { zebedeeCallbackBodySchema } from '../../schemas/zebedee-callback-schema'

const logger = createLogger('zebedee-callback-controller')

export class ZebedeeCallbackController implements IController {
  public constructor(private readonly paymentsService: IPaymentsService) {}

  public async handleRequest(request: Request, response: Response) {
    logger('request headers: %o', request.headers)
    logger('request body: %O', request.body)

    const bodyValidation = validateSchema(zebedeeCallbackBodySchema)(request.body)
    if (bodyValidation.error) {
      logger('zebedee callback request rejected: invalid body %o', bodyValidation.error)
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Malformed body')
      return
    }

    const settings = createSettings()

    const { ipWhitelist = [] } = settings.paymentsProcessors?.zebedee ?? {}
    const remoteAddress = getRemoteAddress(request, settings)

    if (ipWhitelist.length && !ipWhitelist.includes(remoteAddress)) {
      logger('unauthorized request from %s to /callbacks/zebedee', remoteAddress)
      response.status(403).send('Forbidden')
      return
    }

    const invoice = fromZebedeeInvoice(request.body)

    logger('invoice', invoice)

    let updatedInvoice: Invoice
    try {
      updatedInvoice = await this.paymentsService.updateInvoiceStatus(invoice)
    } catch (error) {
      logger.error(`Unable to persist invoice ${invoice.id}`, error)

      throw error
    }

    if (updatedInvoice.status !== InvoiceStatus.COMPLETED && !updatedInvoice.confirmedAt) {
      response.status(200).send()

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
      logger.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response.status(200).setHeader('content-type', 'text/plain; charset=utf8').send('OK')
  }
}
