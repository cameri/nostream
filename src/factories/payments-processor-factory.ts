import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createLogger } from './logger-factory'
import { createSettings } from './settings-factory'
import { IPaymentsProcessor } from '../@types/clients'
import { LNbitsPaymentsProcesor } from '../payments-processors/lnbits-payment-processor'
import { NullPaymentsProcessor } from '../payments-processors/null-payments-processor'
import { PaymentsProcessor } from '../payments-processors/payments-procesor'
import { Settings } from '../@types/settings'
import { ZebedeePaymentsProcesor } from '../payments-processors/zebedee-payments-processor'

const debug = createLogger('create-zebedee-payments-processor')

const getZebedeeAxiosConfig = (settings: Settings): CreateAxiosDefaults<any> => {
  if (!process.env.ZEBEDEE_API_KEY) {
    throw new Error('ZEBEDEE_API_KEY must be set.')
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

const createZebedeePaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const callbackBaseURL = path(['paymentsProcessors', 'zebedee', 'callbackBaseURL'], settings) as string | undefined
  if (typeof callbackBaseURL === 'undefined' || callbackBaseURL.indexOf('nostream.your-domain.com') >= 0) {
    throw new Error('Unable to create payments processor: Setting paymentsProcessor.zebedee.callbackBaseURL is not configured.')
  }

  if (
    !Array.isArray(settings.paymentsProcessors?.zebedee?.ipWhitelist)
    || !settings.paymentsProcessors?.zebedee?.ipWhitelist?.length
  ) {
    throw new Error('Unable to create payments processor: Setting paymentsProcessor.zebedee.ipWhitelist is empty.')
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
    throw new Error('Unable to create payments processor: Setting paymentsProcessor.lnbits.callbackBaseURL is not configured.')
  }

  const config = getLNbitsAxiosConfig(settings)
  debug('config: %o', config)
  const client = axios.create(config)

  const pp = new LNbitsPaymentsProcesor(client, createSettings)

  return new PaymentsProcessor(pp)
}

export const createPaymentsProcessor = (): IPaymentsProcessor => {
  const settings = createSettings()
  if (!settings.payments?.enabled) {
    return new NullPaymentsProcessor()
  }


  switch (settings.payments?.processor) {
    case 'zebedee':
      return createZebedeePaymentsProcessor(settings)
    case 'lnbits':
      return createLNbitsPaymentProcessor(settings)
    default:
      return new NullPaymentsProcessor()
  }
}
