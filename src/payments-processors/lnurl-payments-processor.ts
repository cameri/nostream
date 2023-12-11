import { AxiosInstance } from 'axios'
import { Factory } from '../@types/base'

import { CreateInvoiceRequest, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { InvoiceStatus, InvoiceUnit, LnurlInvoice } from '../@types/invoice'
import { createLogger } from '../factories/logger-factory'
import { randomUUID } from 'crypto'
import { Settings } from '../@types/settings'

const debug = createLogger('lnurl-payments-processor')

export class LnurlPaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private httpClient: AxiosInstance,
    private settings: Factory<Settings>
  ) {}

  public async getInvoice(invoice: LnurlInvoice): Promise<GetInvoiceResponse> {
    debug('get invoice: %s', invoice.id)

    try {
      const response = await this.httpClient.get(invoice.verifyURL)

      return {
        id: invoice.id,
        confirmedAt: response.data.settled ? new Date() : undefined,
        status: response.data.settled ? InvoiceStatus.COMPLETED : InvoiceStatus.PENDING,
      }
    } catch (error) {
      console.error(`Unable to get invoice ${invoice.id}. Reason:`, error)

      throw error
    }
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<any> {
    debug('create invoice: %o', request)
    const {
      amount: amountMsats,
      description,
      requestId,
    } = request

    try {
      const response = await this.httpClient.get(`${this.settings().paymentsProcessors?.lnurl?.invoiceURL}/callback?amount=${amountMsats}&comment=${description}`)

      const result = {
        id: randomUUID(),
        pubkey: requestId,
        bolt11: response.data.pr,
        amountRequested: amountMsats,
        description,
        unit: InvoiceUnit.MSATS,
        status: InvoiceStatus.PENDING,
        expiresAt: null,
        confirmedAt: null,
        createdAt: new Date(),
        verifyURL: response.data.verify,
      }

      debug('result: %o', result)

      return result
    } catch (error) {
      console.error('Unable to request invoice. Reason:', error.message)

      throw error
    }
  }
}
