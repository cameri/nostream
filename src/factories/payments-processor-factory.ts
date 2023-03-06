import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createLogger } from './logger-factory'
import { createSettings } from './settings-factory'
import { IPaymentsProcessor } from '../@types/clients'
import { LNbitsPaymentsProcesor } from '../payments-processors/lnbits-payment-processor'
import { LnurlPaymentsProcesor } from '../payments-processors/lnurl-payments-processor'
import { NullPaymentsProcessor } from '../payments-processors/null-payments-processor'
import { PaymentsProcessor } from '../payments-processors/payments-procesor'
import { Settings } from '../@types/settings'
import { ZebedeePaymentsProcesor } from '../payments-processors/zebedee-payments-processor'

const debug = createLogger('create-payments-processor')

const getZebedeeAxiosConfig = (settings: Settings): CreateAxiosDefaults<any> => {
  if (!process.env.ZEBEDEE_API_KEY) {
    const error = new Error('ZEBEDEE_API_KEY must be set.')
    console.error('Unable to get Zebedee config.', error)
    throw error
  }

  return {
    headers: {
      'content-type': 'application/json',
      'apikey': process.env.ZEBEDEE_API_KEY,
    },
    baseURL: path(['paymentsProcessors', 'zebedee', 'baseURL'], settings),
    maxRedirects: 1,
  }
}

const getLNbitsAxiosConfig = (settings: Settings): CreateAxiosDefaults<any> => {
  if (!process.env.LNBITS_API_KEY) {
    throw new Error('LNBITS_API_KEY must be set to an invoice or admin key.')
  }

  return {
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.LNBITS_API_KEY,
    },
    baseURL: path(['paymentsProcessors', 'lnbits', 'baseURL'], settings),
    maxRedirects: 1,
  }
}

const createLnurlPaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const invoiceURL = path(['paymentsProcessors', 'lnurl', 'invoiceURL'], settings) as string | undefined
  if (typeof invoiceURL === 'undefined') {
    throw new Error('Unable to create payments processor: Setting paymentsProcessor.lnurl.invoiceURL is not configured.')
  }

  const client = axios.create()

  const app = new LnurlPaymentsProcesor(client, createSettings)

  return new PaymentsProcessor(app)
}

const createZebedeePaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const callbackBaseURL = path(['paymentsProcessors', 'zebedee', 'callbackBaseURL'], settings) as string | undefined
  if (typeof callbackBaseURL === 'undefined' || callbackBaseURL.indexOf('nostream.your-domain.com') >= 0) {
    const error = new Error('Setting paymentsProcessor.zebedee.callbackBaseURL is not configured.')
    console.error('Unable to create payments processor.', error)

    throw error
  }

  if (
    !Array.isArray(settings.paymentsProcessors?.zebedee?.ipWhitelist)
    || !settings.paymentsProcessors?.zebedee?.ipWhitelist?.length
  ) {
    const error = new Error('Setting paymentsProcessor.zebedee.ipWhitelist is empty.')
    console.error('Unable to create payments processor.', error)

    throw error
  }

  const config = getZebedeeAxiosConfig(settings)
  debug('config: %o', config)
  const client = axios.create(config)

  const zpp = new ZebedeePaymentsProcesor(client, createSettings)

  return new PaymentsProcessor(zpp)
}

const createLNbitsPaymentProcessor = (settings: Settings): IPaymentsProcessor => {
  const callbackBaseURL = path(['paymentsProcessors', 'lnbits', 'callbackBaseURL'], settings) as string | undefined
  if (typeof callbackBaseURL === 'undefined' || callbackBaseURL.indexOf('nostream.your-domain.com') >= 0) {
    const error = new Error('Setting paymentsProcessor.lnbits.callbackBaseURL is not configured.')
    console.error('Unable to create payments processor.', error)

    throw error
  }

  const config = getLNbitsAxiosConfig(settings)
  debug('config: %o', config)
  const client = axios.create(config)

  const pp = new LNbitsPaymentsProcesor(client, createSettings)

  return new PaymentsProcessor(pp)
}

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
    default:
      return new NullPaymentsProcessor()
  }
}
