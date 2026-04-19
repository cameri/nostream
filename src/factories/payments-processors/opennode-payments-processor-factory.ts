import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createLogger } from '../logger-factory'
import { createSettings } from '../settings-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { OpenNodePaymentsProcessor } from '../../payments-processors/opennode-payments-processor'
import { Settings } from '../../@types/settings'

const logger = createLogger('opennode-payments-processor-factory')

const getOpenNodeAxiosConfig = (settings: Settings): CreateAxiosDefaults<any> => {
  if (!process.env.OPENNODE_API_KEY) {
    const error = new Error('OPENNODE_API_KEY must be set.')
    logger.error('Unable to get OpenNode config. %o', error)
    throw error
  }

  return {
    headers: {
      'content-type': 'application/json',
      authorization: process.env.OPENNODE_API_KEY,
    },
    baseURL: path(['paymentsProcessors', 'opennode', 'baseURL'], settings),
    maxRedirects: 1,
  }
}

export const createOpenNodePaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const callbackBaseURL = path(['paymentsProcessors', 'opennode', 'callbackBaseURL'], settings) as string | undefined
  if (typeof callbackBaseURL === 'undefined' || callbackBaseURL.indexOf('nostream.your-domain.com') >= 0) {
    const error = new Error('Setting paymentsProcessor.opennode.callbackBaseURL is not configured.')
    logger.error('Unable to create payments processor. %o', error)

    throw error
  }

  const config = getOpenNodeAxiosConfig(settings)
  const client = axios.create(config)

  return new OpenNodePaymentsProcessor(client, createSettings)
}
