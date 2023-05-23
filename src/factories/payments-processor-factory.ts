import { createLNbitsPaymentProcessor } from './payments-processors/lnbits-payments-processor-factory'
import { createLnurlPaymentsProcessor } from './payments-processors/lnurl-payments-processor-factory'
import { createLogger } from './logger-factory'
import { createNodelessPaymentsProcessor } from './payments-processors/nodeless-payments-processor-factory'
import { createOpenNodePaymentsProcessor } from './payments-processors/opennode-payments-processor-factory'
import { createSettings } from './settings-factory'
import { createZebedeePaymentsProcessor } from './payments-processors/zebedee-payments-processor-factory'
import { IPaymentsProcessor } from '../@types/clients'
import { NullPaymentsProcessor } from '../payments-processors/null-payments-processor'

const debug = createLogger('create-payments-processor')

export const createPaymentsProcessor = (): IPaymentsProcessor => {
  debug('create payments processor')

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
    default:
      return new NullPaymentsProcessor()
  }
}
