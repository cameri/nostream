import { timingSafeEqual } from 'crypto'

import { Request, Response } from 'express'

import { Invoice, InvoiceStatus } from '../../@types/invoice'
import { createLogger } from '../../factories/logger-factory'
import { createSettings } from '../../factories/settings-factory'
import { getRemoteAddress } from '../../utils/http'
import { hmacSha256 } from '../../utils/secret'
import { IController } from '../../@types/controllers'
import { IPaymentsService } from '../../@types/services'

const debug = createLogger('opennode-callback-controller')

export class OpenNodeCallbackController implements IController {
  public constructor(
    private readonly paymentsService: IPaymentsService,
  ) {}

  public async handleRequest(
    request: Request,
    response: Response,
  ) {
    debug('request headers: %o', request.headers)
    debug('request body: %O', request.body)

    const settings = createSettings()
    const remoteAddress = getRemoteAddress(request, settings)
    const paymentProcessor = settings.payments?.processor

    if (paymentProcessor !== 'opennode') {
      debug('denied request from %s to /callbacks/opennode which is not the current payment processor', remoteAddress)
      response
        .status(403)
        .send('Forbidden')
      return
    }

    const validStatuses = ['expired', 'refunded', 'unpaid', 'processing', 'underpaid', 'paid']

    if (
      !request.body
      || typeof request.body.id !== 'string'
      || typeof request.body.hashed_order !== 'string'
      || typeof request.body.status !== 'string'
      || !validStatuses.includes(request.body.status)
    ) {
      response
        .status(400)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Bad Request')
      return
    }

    const openNodeApiKey = process.env.OPENNODE_API_KEY
    if (!openNodeApiKey) {
      debug('OPENNODE_API_KEY is not configured; unable to verify OpenNode callback from %s', remoteAddress)
      response
        .status(500)
        .setHeader('content-type', 'text/plain; charset=utf8')
        .send('Internal Server Error')
      return
    }

    const expectedBuf = hmacSha256(openNodeApiKey, request.body.id)
    const actualHex = request.body.hashed_order
    const actualBuf = Buffer.from(actualHex, 'hex')

    if (
      expectedBuf.length !== actualBuf.length
      || !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      debug('unauthorized request from %s to /callbacks/opennode: hashed_order mismatch', remoteAddress)
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
      id: request.body.id,
      status: statusMap[request.body.status],
    }

    debug('invoice', invoice)

    let updatedInvoice: Invoice
    try {
      updatedInvoice = await this.paymentsService.updateInvoiceStatus(invoice)
    } catch (error) {
      console.error(`Unable to persist invoice ${invoice.id}`, error)

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
      console.error(`Unable to confirm invoice ${invoice.id}`, error)

      throw error
    }

    response
      .status(200)
      .setHeader('content-type', 'text/plain; charset=utf8')
      .send('OK')
  }
}
