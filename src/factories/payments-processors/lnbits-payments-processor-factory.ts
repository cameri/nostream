import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createLogger } from '../logger-factory'
import { createSettings } from '../settings-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { LNbitsPaymentsProcessor } from '../../payments-processors/lnbits-payment-processor'
import { Settings } from '../../@types/settings'

const logger = createLogger('lnbits-payments-processor-factory')

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

export const createLNbitsPaymentProcessor = (settings: Settings): IPaymentsProcessor => {
  const callbackBaseURL = path(['paymentsProcessors', 'lnbits', 'callbackBaseURL'], settings) as string | undefined
  if (typeof callbackBaseURL === 'undefined' || callbackBaseURL.indexOf('nostream.your-domain.com') >= 0) {
    const error = new Error('Setting paymentsProcessor.lnbits.callbackBaseURL is not configured.')
    logger.error('Unable to create payments processor. %o', error)

    throw error
  }

  const config = getLNbitsAxiosConfig(settings)

  const client = axios.create(config)

  return new LNbitsPaymentsProcessor(client, createSettings)
}
