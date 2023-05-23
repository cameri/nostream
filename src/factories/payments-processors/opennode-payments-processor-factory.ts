import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createSettings } from '../settings-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { OpenNodePaymentsProcesor } from '../../payments-processors/opennode-payments-processor'
import { Settings } from '../../@types/settings'

const getOpenNodeAxiosConfig = (settings: Settings): CreateAxiosDefaults<any> => {
  if (!process.env.OPENNODE_API_KEY) {
    const error = new Error('OPENNODE_API_KEY must be set.')
    console.error('Unable to get OpenNode config.', error)
    throw error
  }

  return {
    headers: {
      'content-type': 'application/json',
      'authorization': process.env.OPENNODE_API_KEY,
    },
    baseURL: path(['paymentsProcessors', 'opennode', 'baseURL'], settings),
    maxRedirects: 1,
  }
}

export const createOpenNodePaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const callbackBaseURL = path(['paymentsProcessors', 'opennode', 'callbackBaseURL'], settings) as string | undefined
  if (typeof callbackBaseURL === 'undefined' || callbackBaseURL.indexOf('nostream.your-domain.com') >= 0) {
    const error = new Error('Setting paymentsProcessor.opennode.callbackBaseURL is not configured.')
    console.error('Unable to create payments processor.', error)

    throw error
  }

  const config = getOpenNodeAxiosConfig(settings)
  const client = axios.create(config)

  return new OpenNodePaymentsProcesor(client, createSettings)
}
