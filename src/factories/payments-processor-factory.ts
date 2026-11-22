import {
  CreateInvoiceRequest,
  CreateInvoiceResponse,
  GetInvoiceResponse,
  IPaymentsProcessor,
  PayInvoiceRequest,
  PayInvoiceResponse,
  PaymentsProcessorCannotPayError,
} from '../@types/clients'
import { Invoice } from '../@types/invoice'
import { createLNbitsPaymentProcessor } from './payments-processors/lnbits-payments-processor-factory'
import { createLnurlPaymentsProcessor } from './payments-processors/lnurl-payments-processor-factory'
import { createLogger } from './logger-factory'
import { createNodelessPaymentsProcessor } from './payments-processors/nodeless-payments-processor-factory'
import { createNwcPaymentsProcessor } from './payments-processors/nwc-payments-processor-factory'
import { createOpenNodePaymentsProcessor } from './payments-processors/opennode-payments-processor-factory'
import { createSettings } from './settings-factory'
import { createZebedeePaymentsProcessor } from './payments-processors/zebedee-payments-processor-factory'
import { NullPaymentsProcessor } from '../payments-processors/null-payments-processor'

const logger = createLogger('create-payments-processor')

export const createPaymentsProcessor = (): IPaymentsProcessor => {
  logger('create payments processor')

  const settings = createSettings()
  if (!settings.payments?.enabled) {
    return new NullPaymentsProcessor()
  }

  switch (settings.payments?.processor) {
    case 'lnurl':
      return createLnurlPaymentsProcessor(settings)
    case 'zebedee':
      return createZebedeePaymentsProcessor(settings)
    case 'lnbits':
      return createLNbitsPaymentProcessor(settings)
    case 'nodeless':
      return createNodelessPaymentsProcessor(settings)
    case 'opennode':
      return createOpenNodePaymentsProcessor(settings)
    case 'nwc':
      return createNwcPaymentsProcessor(settings)
    default:
      return new NullPaymentsProcessor()
  }
}

/**
 * Defers the real processor creation until a call needs it. This keeps creating
 * the peering billing service (or the payments service) from throwing on a
 * missing provider credential for clients that never use payments.
 */
export class LazyPaymentsProcessor implements IPaymentsProcessor {
  private processor?: IPaymentsProcessor

  public constructor(private readonly createProcessor: () => IPaymentsProcessor = createPaymentsProcessor) {}

  private get(): IPaymentsProcessor {
    if (!this.processor) {
      this.processor = this.createProcessor()
    }

    return this.processor
  }

  public createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    return this.get().createInvoice(request)
  }

  public getInvoice(
    invoice: string | Invoice,
    direction?: 'incoming' | 'outgoing',
  ): Promise<GetInvoiceResponse> {
    return direction ? this.get().getInvoice(invoice, direction) : this.get().getInvoice(invoice)
  }

  public payInvoice(request: PayInvoiceRequest): Promise<PayInvoiceResponse> {
    const processor = this.get()
    if (typeof processor.payInvoice !== 'function') {
      throw new PaymentsProcessorCannotPayError()
    }

    return processor.payInvoice(request)
  }
}
