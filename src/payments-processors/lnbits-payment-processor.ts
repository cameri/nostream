import { AxiosInstance } from 'axios'
import { Factory } from '../@types/base'
import { randomUUID } from 'crypto'

import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { createLogger } from '../factories/logger-factory'
import { fromLnbitsInvoice } from '../utils/transform'
import { IInvoiceRepository } from '../@types/repositories'
import { InvoiceStatus } from '../@types/invoice'
import { Settings } from '../@types/settings'

const debug = createLogger('lnbits-payments-processor')

export class LNbitsPaymentsProcesor implements IPaymentsProcessor {
  private static readonly invoiceExpiry = 600

  public constructor(
    private httpClient: AxiosInstance,
    private settings: Factory<Settings>,
    private invoiceRepository: IInvoiceRepository
  ) {}

  public async getInvoice(invoiceId: string): Promise<GetInvoiceResponse> {
    debug('get invoice: %s', invoiceId)

    const databaseInvoice = await this.invoiceRepository.findById(invoiceId)

    try {
      const decodeRes = await this.httpClient.post('v1/payments/decode', {
        data: databaseInvoice.bolt11,
      }, {
        maxRedirects: 1,
      })
      const response = await this.httpClient.get(`/v1/payments/${decodeRes.data.payment_hash}`, {
        maxRedirects: 1,
      })

      if (response.data.paid) {
        databaseInvoice.status = InvoiceStatus.COMPLETED
        databaseInvoice.amountPaid = databaseInvoice.amountRequested
        databaseInvoice.confirmedAt = new Date()
      }

      return databaseInvoice
    } catch (error) {
      // This error is expected when Lnbits prunes expired invoices from its datbase
      if (error.response.data.detail === 'Payment does not exist.') {
        return databaseInvoice
      }

      console.error(`Unable to get invoice ${invoiceId}. Reason:`, error)

      throw error
    }
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    debug('create invoice: %o', request)
    const {
      amount: amountMsats,
      description,
      requestId,
    } = request

    let amountSats = amountMsats.toString()
    // Slice away the msats because Lnbits doesn't support them in their API
    amountSats = amountSats.slice(0, amountSats.length - 3)

    const id = randomUUID()

    const body = {
      out: false,
      amount: amountSats,
      memo: description,
      extra: {
        id,
      },
      expiry: LNbitsPaymentsProcesor.invoiceExpiry,
      webhook: this.settings().paymentsProcessors?.lnbits?.callbackBaseURL,
    }

    try {
      debug('request body: %o', body)
      const response = await this.httpClient.post('/v1/payments', body, {
        maxRedirects: 1,
      })

      const result = fromLnbitsInvoice({
        id,
        requestId,
        amountSats,
        description,
        expirySeconds: LNbitsPaymentsProcesor.invoiceExpiry,
        ...response.data,
      })

      debug('result: %o', result)

      return result
    } catch (error) {
      console.error('Unable to request invoice. Reason:', error.message)

      throw error
    }
  }
}
