import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { deriveFromSecret, hmacSha256 } from '../utils/secret'
import { Invoice, InvoiceStatus, InvoiceUnit } from '../@types/invoice'

import { AxiosInstance } from 'axios'
import { createLogger } from '../factories/logger-factory'
import { Factory } from '../@types/base'
import { Pubkey } from '../@types/base'
import { Settings } from '../@types/settings'

const debug = createLogger('lnbits-payments-processor')

export class LNbitsInvoice implements Invoice {
  id: string
  pubkey: Pubkey
  bolt11: string
  amountRequested: bigint
  amountPaid?: bigint
  unit: InvoiceUnit
  status: InvoiceStatus
  description: string
  confirmedAt?: Date | null
  expiresAt: Date | null
  updatedAt: Date
  createdAt: Date
}

export class LNbitsCreateInvoiceResponse implements CreateInvoiceResponse {
  id: string
  pubkey: string
  bolt11: string
  amountRequested: bigint
  description: string
  unit: InvoiceUnit
  status: InvoiceStatus
  expiresAt: Date | null
  confirmedAt?: Date | null
  createdAt: Date
  rawResponse?: string
}

export class LNbitsPaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private httpClient: AxiosInstance,
    private settings: Factory<Settings>
  ) {}

  public async getInvoice(invoiceId: string): Promise<GetInvoiceResponse> {
    debug('get invoice: %s', invoiceId)
    try {
      const response = await this.httpClient.get(`/api/v1/payments/${invoiceId}`, {
        maxRedirects: 1,
      })
      const invoice = new LNbitsInvoice()
      const data = response.data
      invoice.id = data.details.payment_hash
      invoice.pubkey = data.details.extra.internalId
      invoice.bolt11 = data.details.bolt11
      invoice.amountRequested = BigInt(Math.floor(data.details.amount / 1000))
      if (data.paid) invoice.amountPaid = BigInt(Math.floor(data.details.amount / 1000))
      invoice.unit = InvoiceUnit.SATS
      invoice.status = data.paid?InvoiceStatus.COMPLETED:InvoiceStatus.PENDING
      invoice.description = data.details.memo
      invoice.confirmedAt = data.paid ? new Date(data.details.time * 1000) : null
      invoice.expiresAt = new Date(data.details.expiry * 1000)
      invoice.createdAt = new Date(data.details.time * 1000)
      invoice.updatedAt = new Date()
      return invoice
    } catch (error) {
      console.error(`Unable to get invoice ${invoiceId}. Reason:`, error)

      throw error
    }
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    debug('create invoice: %o', request)
    const {
      amount: amountMsats,
      description,
      requestId: internalId,
    } = request

    const callbackURL = new URL(this.settings().paymentsProcessors?.lnbits?.callbackBaseURL)
    const hmacExpiry = (Date.now() + (1 * 24 * 60 * 60 * 1000)).toString()
    callbackURL.searchParams.set('hmac', hmacExpiry + ':' + 
      hmacSha256(deriveFromSecret('lnbits-callback-hmac-key'), hmacExpiry).toString('hex'))

    const body = {
      amount: Number(amountMsats / 1000n),
      memo: description,
      extra: {
        internalId,
      },
      out: false,
      webhook: callbackURL.toString(),
    }

    try {
      debug('request body: %o', body)
      const response = await this.httpClient.post('/api/v1/payments', body, {
        maxRedirects: 1,
      })

      debug('response: %o', response.data)

      const invoiceResponse = await this.httpClient.get(`/api/v1/payments/${encodeURIComponent(response.data.payment_hash)}`, {
        maxRedirects: 1,
      })
      debug('invoice data response: %o', invoiceResponse.data)

      const invoice = new LNbitsCreateInvoiceResponse()
      const data = invoiceResponse.data
      invoice.id = data.details.payment_hash
      invoice.pubkey = data.details.extra.internalId
      invoice.bolt11 = data.details.bolt11
      invoice.amountRequested = BigInt(Math.floor(data.details.amount / 1000))
      invoice.unit = InvoiceUnit.SATS
      invoice.status = data.paid?InvoiceStatus.COMPLETED:InvoiceStatus.PENDING
      invoice.description = data.details.memo
      invoice.confirmedAt = null
      invoice.expiresAt = new Date(data.details.expiry * 1000)
      invoice.createdAt = new Date(data.details.time * 1000)
      invoice.rawResponse = JSON.stringify({
        invoiceResponse: invoiceResponse.data,
        createData: response.data,
      })

      return invoice
    } catch (error) {
      console.error('Unable to request invoice. Reason:', error.message)

      throw error
    }
  }
}
