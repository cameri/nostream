import { ICacheAdapter } from '../@types/adapters'
import { RedisAdapter } from '../adapters/redis-adapter'
import { getCacheClient } from '../cache/client'
import { createLogger } from '../factories/logger-factory'
import { DEFAULT_NIP98_MAX_SKEW_SECONDS } from './nip98'

const logger = createLogger('nip98-replay')

let cacheAdapter: ICacheAdapter | undefined

const getCache = (): ICacheAdapter => {
  if (!cacheAdapter) {
    cacheAdapter = new RedisAdapter(getCacheClient())
  }

  return cacheAdapter
}

export const nip98AuthReplayCacheKey = (eventId: string): string => `nip98:auth:${eventId}`

const resolveMaxSkewSeconds = (maxSkewSeconds: number | undefined): number => {
  if (typeof maxSkewSeconds === 'number' && Number.isSafeInteger(maxSkewSeconds) && maxSkewSeconds > 0) {
    return maxSkewSeconds
  }

  return DEFAULT_NIP98_MAX_SKEW_SECONDS
}

/**
 * Keep the replay claim until the event leaves the verifier's skew window.
 * `verifyNip98Auth` accepts |now - created_at| <= maxSkew, including future timestamps,
 * so a TTL of only maxSkew from first use can expire while the event is still valid.
 */
export const resolveNip98ReplayTtlSeconds = (
  createdAt: number,
  maxSkewSeconds?: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number => {
  const maxSkew = resolveMaxSkewSeconds(maxSkewSeconds)
  // Inclusive last valid second is created_at + maxSkew. Redis EX drops the key after
  // ttl seconds, so +1 keeps the claim through that boundary.
  const remainingInclusive = createdAt + maxSkew - nowSeconds + 1
  if (!Number.isSafeInteger(remainingInclusive) || remainingInclusive < 1) {
    return 1
  }

  const maxTtl = 2 * maxSkew + 1
  return remainingInclusive > maxTtl ? maxTtl : remainingInclusive
}

export const claimNip98AuthEventId = async (
  eventId: string,
  ttlSeconds: number,
  cache: ICacheAdapter = getCache(),
): Promise<'claimed' | 'replay' | 'unavailable'> => {
  const expirySeconds = Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 1

  try {
    const created = await cache.setKeyIfNotExists(nip98AuthReplayCacheKey(eventId), '1', expirySeconds)
    return created ? 'claimed' : 'replay'
  } catch (error) {
    logger('unable to claim NIP-98 auth event %s: %o', eventId, error)
    return 'unavailable'
  }
}

export const resetNip98ReplayCacheAdapterForTests = (): void => {
  cacheAdapter = undefined
}
