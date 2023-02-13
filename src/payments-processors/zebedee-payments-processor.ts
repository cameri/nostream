import { AxiosInstance } from 'axios'
import { Factory } from '../@types/base'

import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { createLogger } from '../factories/logger-factory'
import { fromZebedeeInvoice } from '../utils/transform'
import { Invoice } from '../@types/invoice'
import { Settings } from '../@types/settings'

const debug = createLogger('zebedee-payments-processor')

export class ZebedeePaymentsProcesor implements IPaymentsProcessor {
  public constructor(
    private httpClient: AxiosInstance,
    private settings: Factory<Settings>
  ) {}

  public async getInvoice(invoice: Invoice): Promise<GetInvoiceResponse> {
    debug('get invoice: %s', invoice.id)

    try {
      const response = await this.httpClient.get(`/v0/charges/${invoice.id}`, {
        maxRedirects: 1,
      })

      return fromZebedeeInvoice(response.data.data)
    } catch (error) {
      console.error(`Unable to get invoice ${invoice.id}. Reason:`, error)

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

    const body = {
      amount: amountMsats.toString(),
      description,
      internalId: requestId,
      callbackUrl: this.settings().paymentsProcessors?.zebedee?.callbackBaseURL,
    }

    try {
      debug('request body: %o', body)
      const response = await this.httpClient.post('/v0/charges', body, {
        maxRedirects: 1,
      })

      const result = fromZebedeeInvoice(response.data.data)

      debug('result: %o', result)

      return result
    } catch (error) {
      console.error('Unable to request invoice. Reason:', error.message)

      throw error
    }
  }
}
