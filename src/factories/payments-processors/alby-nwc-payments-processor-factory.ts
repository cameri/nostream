import { createSettings } from '../settings-factory'
import { AlbyNwcPaymentsProcessor } from '../../payments-processors/alby-nwc-payments-processor'
import { IPaymentsProcessor } from '../../@types/clients'
import { Settings } from '../../@types/settings'

const getAlbyNwcConfig = (settings: Settings): { nwcUrl: string; replyTimeoutMs: number } => {
  const nwcUrl = process.env.ALBY_NWC_URL

  if (!nwcUrl) {
    const error = new Error('ALBY_NWC_URL must be set.')
    console.error('Unable to create Alby NWC payments processor.', error)
    throw error
  }

  if (!nwcUrl.startsWith('nostr+walletconnect://') && !nwcUrl.startsWith('nostrwalletconnect://')) {
    const error = new Error('ALBY_NWC_URL must be a valid nostr+walletconnect:// or nostrwalletconnect:// URI.')
    console.error('Unable to create Alby NWC payments processor.', error)
    throw error
  }

  try {
    new URL(nwcUrl)
  } catch {
    const error = new Error('ALBY_NWC_URL is not parseable as a URL.')
    console.error('Unable to create Alby NWC payments processor.', error)
    throw error
  }

  const replyTimeoutMs = settings.paymentsProcessors?.alby?.replyTimeoutMs
  if (typeof replyTimeoutMs !== 'number' || replyTimeoutMs <= 0) {
    const error = new Error('Setting paymentsProcessors.alby.replyTimeoutMs must be a positive number.')
    console.error('Unable to create Alby NWC payments processor.', error)
    throw error
  }

  return { nwcUrl, replyTimeoutMs }
}

export const createAlbyNwcPaymentsProcessor = (settings: Settings): IPaymentsProcessor => {
  const { nwcUrl, replyTimeoutMs } = getAlbyNwcConfig(settings)

  return new AlbyNwcPaymentsProcessor(nwcUrl, replyTimeoutMs, createSettings)
}
