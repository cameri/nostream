import { AxiosInstance } from 'axios'
import { Factory } from '../@types/base'

import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { createLogger } from '../factories/logger-factory'
import { fromOpenNodeInvoice } from '../utils/transform'
import { Settings } from '../@types/settings'

const debug = createLogger('opennode-payments-processor')

export class OpenNodePaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private httpClient: AxiosInstance,
    private settings: Factory<Settings>
  ) {}

  public async getInvoice(invoiceId: string): Promise<GetInvoiceResponse> {
    debug('get invoice: %s', invoiceId)

    try {
      const response = await this.httpClient.get(`/v2/charge/${invoiceId}`, {
        maxRedirects: 1,
      })

      return fromOpenNodeInvoice(response.data.data)
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
      requestId,
    } = request

    const amountSats = Number(amountMsats / 1000n)

    const body = {
      amount: amountSats,
      description,
      order_id: requestId,
      callback_url: this.settings().paymentsProcessors?.opennode?.callbackBaseURL,
      ttl: 10,
    }

    try {
      debug('request body: %o', body)
      const response = await this.httpClient.post('/v1/charges', body, {
        maxRedirects: 1,
      })

      const result = fromOpenNodeInvoice(response.data.data)

      debug('result: %o', result)

      return result
    } catch (error) {
      console.error('Unable to request invoice. Reason:', error.message)

      throw error
    }
  }
}
