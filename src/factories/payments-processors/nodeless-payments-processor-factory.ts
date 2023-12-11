import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createSettings } from '../settings-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { NodelessPaymentsProcessor } from '../../payments-processors/nodeless-payments-processor'
import { Settings } from '../../@types/settings'

const getNodelessAxiosConfig = (settings: Settings): CreateAxiosDefaults<any> => {
  if (!process.env.NODELESS_API_KEY) {
    const error = new Error('NODELESS_API_KEY must be set.')
    console.error('Unable to get Nodeless config.', error)
    throw error
  }

  return {
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${process.env.NODELESS_API_KEY}`,
      'accept': 'application/json',
    },
    baseURL: path(['paymentsProcessors', 'nodeless', 'baseURL'], settings),
    maxRedirects: 1,
  }
}

export const createNodelessPaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const client = axios.create(getNodelessAxiosConfig(settings))

  return new NodelessPaymentsProcessor(client, createSettings)
}
