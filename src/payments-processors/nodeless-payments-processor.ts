import { AxiosInstance } from 'axios'
import { Factory } from '../@types/base'

import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { createLogger } from '../factories/logger-factory'
import { fromNodelessInvoice } from '../utils/transform'
import { Settings } from '../@types/settings'

const logger = createLogger('nodeless-payments-processor')

export class NodelessPaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private httpClient: AxiosInstance,
    private settings: Factory<Settings>,
  ) {}

  public async getInvoice(invoiceId: string): Promise<GetInvoiceResponse> {
    logger('get invoice: %s', invoiceId)

    const { storeId } = this.settings().paymentsProcessors.nodeless

    try {
      const response = await this.httpClient.get(`/api/v1/store/${storeId}/invoice/${invoiceId}`, {
        maxRedirects: 1,
      })

      return fromNodelessInvoice(response.data.data)
    } catch (error) {
      logger.error(`Unable to get invoice ${invoiceId}. Reason:`, error)

      throw error
    }
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    logger('create invoice: %O', request)
    const { amount: amountMsats, description, requestId } = request

    const amountSats = Number(amountMsats / 1000n)

    const body = {
      amount: amountSats,
      currency: 'SATS',
      metadata: {
        description,
        requestId,
        unit: 'sats',
        createdAt: new Date().toISOString(),
      },
    }

    const { storeId } = this.settings().paymentsProcessors.nodeless

    try {
      logger('request body: %O', body)
      const response = await this.httpClient.post(`/api/v1/store/${storeId}/invoice`, body, {
        maxRedirects: 1,
      })

      logger('response headers: %O', response.headers)
      logger('response data: %O', response.data)

      const result = fromNodelessInvoice(response.data.data)

      logger('invoice: %O', result)

      return result
    } catch (error) {
      logger.error('Unable to request invoice. Reason:', error.message)

      throw error
    }
  }
}
