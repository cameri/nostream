import axios from 'axios'

import { createSettings } from './settings-factory'
import { ISettings } from '../@types/settings'
import { NullPaymentsProcessor } from '../payments-processors/null-payments-processor'
import { PaymentsProcessor } from '../payments-processors/payments-procesor'
import { ZebedeePaymentsProcesor } from '../payments-processors/zebedee-payments-processor'

const createZebedeePaymentsProcessor = (settings: ISettings) => {
  const client = axios.create({
    headers: {
      'content-type': 'application/json',
      'apikey': process.env.ZEBEDEE_API_KEY,
    },
    baseURL: settings.paymentProcessors.zebedee.baseURL,
    maxRedirects: 1,
  })

  const zpp = new ZebedeePaymentsProcesor(client, createSettings)
  return new PaymentsProcessor(zpp)
}

export const createPaymentsProcessor = () => {
  const settings = createSettings()
  if (!settings.payments.enabled) {
    throw new Error('Payments disabled')
  }

  switch (settings.payments.processor) {
    case 'zebedee':
      return createZebedeePaymentsProcessor(settings)
    default:
      return new NullPaymentsProcessor()
  }
}