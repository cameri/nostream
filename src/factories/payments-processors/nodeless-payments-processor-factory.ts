import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createLogger } from '../logger-factory'
import { createSettings } from '../settings-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { NodelessPaymentsProcessor } from '../../payments-processors/nodeless-payments-processor'
import { Settings } from '../../@types/settings'

const logger = createLogger('nodeless-payments-processor-factory')

const getNodelessAxiosConfig = (settings: Settings): CreateAxiosDefaults<any> => {
  if (!process.env.NODELESS_API_KEY) {
    const error = new Error('NODELESS_API_KEY must be set.')
    logger.error('Unable to get Nodeless config. %o', error)
    throw error
  }

  return {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.NODELESS_API_KEY}`,
      accept: 'application/json',
    },
    baseURL: path(['paymentsProcessors', 'nodeless', 'baseURL'], settings),
    maxRedirects: 1,
  }
}

export const createNodelessPaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const client = axios.create(getNodelessAxiosConfig(settings))

  return new NodelessPaymentsProcessor(client, createSettings)
}
