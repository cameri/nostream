import { timingSafeEqual } from 'crypto'

import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getRemoteAddress } from '../../utils/http'
import { hmacSha256 } from '../../utils/secret'
import { IController } from '../../@types/controllers'
import { IPaymentsService } from '../../@types/services'
import { opennodeWebhookCallbackBodySchema } from '../../schemas/opennode-callback-schema'
import { validateSchema } from '../../utils/validation'

const logger = createLogger('opennode-callback-controller')

export class OpenNodeCallbackController implements IController {
  public constructor(private readonly paymentsService: IPaymentsService) {}

  public async handleRequest(request: Request, response: Response) {
    logger('request headers: %o', request.headers)

    const settings = createSettings()
    const remoteAddress = getRemoteAddress(request, settings)

    const bodyValidation = validateSchema(opennodeWebhookCallbackBodySchema)(request.body)
    if (bodyValidation.error) {
      logger('opennode callback request rejected: invalid body %o', bodyValidation.error)
      response.status(400).setHeader('content-type', 'text/plain; charset=utf8').send('Malformed body')
      return
    }

    const body = bodyValidation.value
    logger(
      'request body metadata: hasId=%s hasHashedOrder=%s status=%s',
      typeof body.id === 'string',
      typeof body.hashed_order === 'string',
      body.status,
    )

    const openNodeApiKey = process.env.OPENNODE_API_KEY
    if (!openNodeApiKey) {
      logger('OPENNODE_API_KEY is not configured; unable to verify OpenNode callback from %s', remoteAddress)
      response
        .status(500)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Internal Server Error')
      return
    }

    const expectedBuf = hmacSha256(openNodeApiKey, body.id)
    const actualHex = body.hashed_order
    const expectedHexLength = expectedBuf.length * 2

    if (
      actualHex.length !== expectedHexLength
      || !/^[0-9a-f]+$/i.test(actualHex)
    ) {
      logger('invalid hashed_order format from %s to /callbacks/opennode', remoteAddress)
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Bad Request')
      return
    }

    const actualBuf = Buffer.from(actualHex, 'hex')

    if (
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      logger('unauthorized request from %s to /callbacks/opennode: hashed_order mismatch', remoteAddress)
      response
        .status(403)
        .send('Forbidden')
      return
    }

    const statusMap: Record<string, InvoiceStatus> = {
      expired: InvoiceStatus.EXPIRED,
      refunded: InvoiceStatus.EXPIRED,
      unpaid: InvoiceStatus.PENDING,
      processing: InvoiceStatus.PENDING,
      underpaid: InvoiceStatus.PENDING,
      paid: InvoiceStatus.COMPLETED,
    }

    const invoice: Pick<Invoice, 'id' | 'status'> = {
      id: body.id,
      status: statusMap[body.status],
    }

    logger('invoice', invoice)

    let updatedInvoice: Invoice
    try {
      updatedInvoice = await this.paymentsService.updateInvoiceStatus(invoice)
    } catch (error) {
      logger.error(`Unable to persist invoice ${invoice.id}`, error)

      throw error
    }

    if (updatedInvoice.status !== InvoiceStatus.COMPLETED) {
      response
        .status(200)
        .send()

      return
    }

    if (!updatedInvoice.confirmedAt) {
      updatedInvoice.confirmedAt = new Date()
    }
    updatedInvoice.amountPaid = updatedInvoice.amountRequested

    try {
      await this.paymentsService.confirmInvoice({
        id: updatedInvoice.id,
        pubkey: updatedInvoice.pubkey,
        status: updatedInvoice.status,
        amountPaid: updatedInvoice.amountPaid,
        confirmedAt: updatedInvoice.confirmedAt,
      })
      await this.paymentsService.sendInvoiceUpdateNotification(updatedInvoice)
    } catch (error) {
      logger.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response.status(200).setHeader('content-type', 'text/plain; charset=utf8').send('OK')
  }
}
