import { Factory } from '../@types/base'
import { Settings } from '../@types/settings'
import { IRateLimiter } from '../@types/utils'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('peer-requests')

/** Request kinds that consume the on-demand peer budget. */
export type PeerRequestType = 'REQ' | 'COUNT' | 'NEG-OPEN'

const FALLBACK_RETRY_AFTER_MS = 60_000

/**
 * Per-peer-pubkey on-demand request limit. Returns a retry-after in ms when the
 * request is refused, or undefined when allowed. The limiter is fail-closed:
 * an unavailable store must not turn a peer credential into unbounded egress.
 */
export const getPeerRequestRetryAfterMs = async (
  rateLimiter: Factory<IRateLimiter>,
  settings: Settings,
  peerPubkey: string,
  type: PeerRequestType,
): Promise<number | undefined> => {
  const rateLimits = settings.limits?.peer?.request?.rateLimits
  if (!Array.isArray(rateLimits) || rateLimits.length === 0) {
    return undefined
  }

  const limiter = rateLimiter()

  for (const { period, rate } of rateLimits) {
    try {
      const result = await limiter.hit(`${peerPubkey}:peer-request:${period}`, 1, { period, rate })
      if (!result.limited) {
        continue
      }

      logger('rate limited peer %s (%s): %d requests / %d ms exceeded', peerPubkey, type, rate, period)

      return result.retryAfterMs ?? Math.max(1, Math.ceil(period))
    } catch (error) {
      logger.error('peer request rate limiter unavailable for %s (%s): %o', peerPubkey, type, error)

      return FALLBACK_RETRY_AFTER_MS
    }
  }

  return undefined
}
