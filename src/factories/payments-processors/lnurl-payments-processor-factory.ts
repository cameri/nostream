import axios from 'axios'
import { path } from 'ramda'

import { createSettings } from '../settings-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { LnurlPaymentsProcessor } from '../../payments-processors/lnurl-payments-processor'
import { Settings } from '../../@types/settings'

export const createLnurlPaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const invoiceURL = path(['paymentsProcessors', 'lnurl', 'invoiceURL'], settings) as string | undefined
  if (typeof invoiceURL === 'undefined') {
    throw new Error('Unable to create payments processor: Setting paymentsProcessor.lnurl.invoiceURL is not configured.')
  }

  const client = axios.create()

  return new LnurlPaymentsProcessor(client, createSettings)
}
