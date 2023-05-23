import axios, { CreateAxiosDefaults } from 'axios'
import { path } from 'ramda'

import { createSettings } from '../settings-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { Settings } from '../../@types/settings'
import { ZebedeePaymentsProcesor } from '../../payments-processors/zebedee-payments-processor'

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

export const createZebedeePaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
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

  const client = axios.create(config)

  return new ZebedeePaymentsProcesor(client, createSettings)
}