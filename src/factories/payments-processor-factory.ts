import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createLogger } from './logger-factory'
import { createSettings } from './settings-factory'
import { IInvoiceRepository } from '../@types/repositories'
import { IPaymentsProcessor } from '../@types/clients'
import { LNbitsPaymentsProcesor } from '../payments-processors/lnbits-payment-processor'
import { NullPaymentsProcessor } from '../payments-processors/null-payments-processor'
import { PaymentsProcessor } from '../payments-processors/payments-procesor'
import { Settings } from '../@types/settings'
import { ZebedeePaymentsProcesor } from '../payments-processors/zebedee-payments-processor'

const debug = createLogger('create-zebedee-payments-processor')

export enum PaymentProcessors {
  Zebedee = 'zebedee',
  Lnbits = 'lnbits',
}

const validatePaymentSettings = (processor: PaymentProcessors, settings: Settings) => {
  const callbackBaseURL = path(['paymentsProcessors', processor, 'callbackBaseURL'], settings) as string | undefined
  if (typeof callbackBaseURL === 'undefined' || callbackBaseURL.indexOf('nostream.your-domain.com') >= 0) {
    throw new Error(`Unable to create payments processor: Setting paymentsProcessor.${processor}.callbackBaseURL is not configured.`)
  }

  if (
    !Array.isArray(settings.paymentsProcessors?.[processor]?.ipWhitelist)
    || !settings.paymentsProcessors?.[processor]?.ipWhitelist?.length
  ) {
    throw new Error(`Unable to create payments processor: Setting paymentsProcessor.${processor}.ipWhitelist is empty.`)
  }
}

const getPaymentProcessorConfig = (processor: PaymentProcessors, settings: Settings): CreateAxiosDefaults<any> => {
  let apiKey: string

  switch (processor) {
    case PaymentProcessors.Zebedee:
      apiKey = 'ZEBEDEE_API_KEY'
      break

    case PaymentProcessors.Lnbits:
      apiKey = 'LNBITS_API_KEY'
      break
  }

  if (!process.env[apiKey]) {
    throw new Error(`${apiKey} must be set.`)
  }

  const apiKeyHeader = processor === PaymentProcessors.Zebedee ? 'apikey' : 'X-Api-Key'

  return {
    headers: {
      'content-type': 'application/json',
      [apiKeyHeader]: process.env[apiKey],
    },
    baseURL: path(['paymentsProcessors', processor, 'baseURL'], settings),
    maxRedirects: 1,
  }
}

const setupPaymentsProcessor = (
  processor: PaymentProcessors,
  settings: Settings,
  invoiceRepository: IInvoiceRepository,
): IPaymentsProcessor => {
  validatePaymentSettings(processor, settings)

  const config = getPaymentProcessorConfig(processor, settings)
  debug(`${processor} config: %o`, config)
  const client = axios.create(config)

  let zpp: IPaymentsProcessor

  switch (processor) {
    case PaymentProcessors.Zebedee:
      zpp = new ZebedeePaymentsProcesor(client, createSettings)
      break

    case PaymentProcessors.Lnbits:
      zpp = new LNbitsPaymentsProcesor(client, createSettings, invoiceRepository)
      break
  }

  return new PaymentsProcessor(zpp)
}

export const createPaymentsProcessor = (invoiceRepository: IInvoiceRepository): IPaymentsProcessor => {
  const settings = createSettings()
  if (!settings.payments?.enabled) {
    return new NullPaymentsProcessor()
  }

  switch (settings.payments?.processor) {
    case PaymentProcessors.Zebedee:
      return setupPaymentsProcessor(PaymentProcessors.Zebedee, settings, invoiceRepository)

    case PaymentProcessors.Lnbits:
      return setupPaymentsProcessor(PaymentProcessors.Lnbits, settings, invoiceRepository)

    default:
      return new NullPaymentsProcessor()
  }
}
