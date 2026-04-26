import { createSettings } from '../settings-factory'
import { NwcPaymentsProcessor } from '../../payments-processors/nwc-payments-processor'
import { createLogger } from '../logger-factory'
import { IPaymentsProcessor } from '../../@types/clients'
import { Settings } from '../../@types/settings'

const logger = createLogger('nwc-payments-processor-factory')

const getNwcConfig = (settings: Settings): { nwcUrl: string; replyTimeoutMs: number } => {
  const nwcUrl = process.env.NWC_URL

  if (!nwcUrl) {
    const error = new Error('NWC_URL must be set.')
    logger('Unable to create NWC payments processor. %o', error)
    throw error
  }

  if (!nwcUrl.startsWith('nostr+walletconnect://') && !nwcUrl.startsWith('nostrwalletconnect://')) {
    const error = new Error('NWC_URL must be a valid nostr+walletconnect:// or nostrwalletconnect:// URI.')
    logger('Unable to create NWC payments processor. %o', error)
    throw error
  }

  try {
    new URL(nwcUrl)
  } catch {
    const error = new Error('NWC_URL is not parseable as a URL.')
    logger('Unable to create NWC payments processor. %o', error)
    throw error
  }

  const replyTimeoutMs = settings.paymentsProcessors?.nwc?.replyTimeoutMs
  if (typeof replyTimeoutMs !== 'number' || replyTimeoutMs <= 0) {
    const error = new Error('Setting paymentsProcessors.nwc.replyTimeoutMs must be a positive number.')
    logger('Unable to create NWC payments processor. %o', error)
    throw error
  }

  const invoiceExpirySeconds = settings.paymentsProcessors?.nwc?.invoiceExpirySeconds
  if (typeof invoiceExpirySeconds !== 'number' || !Number.isInteger(invoiceExpirySeconds) || invoiceExpirySeconds <= 0) {
    const error = new Error('Setting paymentsProcessors.nwc.invoiceExpirySeconds must be a positive integer.')
    logger('Unable to create NWC payments processor. %o', error)
    throw error
  }

  return { nwcUrl, replyTimeoutMs }
}

export const createNwcPaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const { nwcUrl, replyTimeoutMs } = getNwcConfig(settings)

  return new NwcPaymentsProcessor(nwcUrl, replyTimeoutMs, createSettings)
}
