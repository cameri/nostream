import { applySpec, path, pipe } from 'ramda'
import { AxiosInstance } from 'axios'
import { Factory } from '../@types/base'

import { CreateInvoiceRequest, CreateInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { createLogger } from '../factories/logger-factory'
import { ISettings } from '../@types/settings'
import { toJSON } from '../utils/transform'

const debug = createLogger('zebedee-payments-processor')

export class ZebedeePaymentsProcesor implements IPaymentsProcessor {
  public constructor(
    private httpClient: AxiosInstance,
    private settings: Factory<ISettings>
  ) {}

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    debug('create invoice: %o', request)
    const {
      amountMsats,
      description,
      requestId,
    } = request

    const body = {
      amount: amountMsats.toString(),
      description,
      internalId: requestId,
      callbackUrl: this.settings().paymentProcessors?.zebedee?.callbackBaseURL,
    }

    try {
      debug('request body: %o', body)
      const response = await this.httpClient.post('/v0/charges', body, {
        maxRedirects: 1,
      })

      const result = pipe(
        applySpec<CreateInvoiceResponse>({
          externalReference: path(['data', 'id']),
          amount: pipe(path(['data', 'amount']), Number),
          invoice: applySpec({
            bolt11: path(['data', 'invoice', 'request']),
          }),
          rawResponse: toJSON,
        })
      )(response.data)

      debug('result: %o', result)

      return result
    } catch (error) {
      console.error('Unable to request invoice. Reason:', error.message)

      throw error
    }
  }
}
