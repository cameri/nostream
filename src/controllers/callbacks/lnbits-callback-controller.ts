import { Request, Response } from 'express'

import { deriveFromSecret, hmacSha256 } from '../../utils/secret'
import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { lnbitsCallbackBodySchema, lnbitsCallbackQuerySchema } from '../../schemas/lnbits-callback-schema'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getRemoteAddress } from '../../utils/http'
import { IController } from '../../@types/controllers'
import { IInvoiceRepository } from '../../@types/repositories'
import { IPaymentsService } from '../../@types/services'
import { validateSchema } from '../../utils/validation'

const logger = createLogger('lnbits-callback-controller')

export class LNbitsCallbackController implements IController {
  public constructor(
    private readonly paymentsService: IPaymentsService,
    private readonly invoiceRepository: IInvoiceRepository,
  ) {}

  public async handleRequest(request: Request, response: Response) {
    logger('request headers: %o', request.headers)
    logger('request body: %o', request.body)

    const settings = createSettings()
    const remoteAddress = getRemoteAddress(request, settings)

    const queryValidation = validateSchema(lnbitsCallbackQuerySchema)(request.query)
    if (queryValidation.error) {
      logger('unauthorized request from %s to /callbacks/lnbits: invalid query %o', remoteAddress, queryValidation.error)
      response.status(403).send('Forbidden')
      return
    }

    const hmac = request.query.hmac as string
    const split = hmac.split(':')
    const expiryString = split[0]
    const expiry = Number(expiryString)
    const hasValidSplit = split.length === 2
    const hasValidExpiry = /^\d+$/.test(expiryString) && Number.isSafeInteger(expiry)
    if (
      !hasValidSplit ||
      hmacSha256(deriveFromSecret('lnbits-callback-hmac-key'), expiryString).toString('hex') !== split[1] ||
      !hasValidExpiry ||
      expiry <= Date.now()
    ) {
      logger('unauthorized request from %s to /callbacks/lnbits: hmac signature mismatch or expired', remoteAddress)
      response.status(403).send('Forbidden')
      return
    }

    const bodyValidation = validateSchema(lnbitsCallbackBodySchema)(request.body)
    if (bodyValidation.error) {
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Malformed body')
      return
    }

    const body = request.body
    const invoice = await this.paymentsService.getInvoiceFromPaymentsProcessor(body.payment_hash)
    const storedInvoice = await this.invoiceRepository.findById(body.payment_hash)

    if (!storedInvoice) {
      response.status(404).setHeader('content-type', 'text/plain; charset=utf8').send('No such invoice')
      return
    }

    try {
      await this.paymentsService.updateInvoice(invoice)
    } catch (error) {
      logger.error(`Unable to persist invoice ${invoice.id}`, error)

      throw error
    }

    if (invoice.status !== InvoiceStatus.COMPLETED && !invoice.confirmedAt) {
      response.status(200).send()

      return
    }

    if (storedInvoice.status === InvoiceStatus.COMPLETED) {
      response.status(409).setHeader('content-type', 'text/plain; charset=utf8').send('Invoice is already marked paid')
      return
    }

    invoice.amountPaid = invoice.amountRequested

    try {
      await this.paymentsService.confirmInvoice(invoice as Invoice)
      await this.paymentsService.sendInvoiceUpdateNotification(invoice as Invoice)
    } catch (error) {
      logger.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response.status(200).setHeader('content-type', 'text/plain; charset=utf8').send('OK')
  }
}
