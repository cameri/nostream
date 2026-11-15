import { ICacheAdapter } from '../@types/adapters'
import { IAdminSessionRevocations } from '../@types/admin'
import { RedisAdapter } from '../adapters/redis-adapter'
import { getCacheClient } from '../cache/client'

let cacheAdapter: ICacheAdapter | undefined

const getCache = (): ICacheAdapter => {
  if (!cacheAdapter) {
    cacheAdapter = new RedisAdapter(getCacheClient())
  }

  return cacheAdapter
}

export const adminSessionRevocationCacheKey = (sessionId: string): string => `admin:session:revoked:${sessionId}`

/**
 * Revoked session ids live in the shared cache, so a logout handled by one worker ends the session on all of
 * them. An entry only has to outlast the token, which is rejected on its own once it has expired.
 */
export class CacheAdminSessionRevocations implements IAdminSessionRevocations {
  public constructor(private readonly cache: () => ICacheAdapter = getCache) {}

  public async revoke(sessionId: string, ttlSeconds: number): Promise<void> {
    const expirySeconds = Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 1

    await this.cache().setKey(adminSessionRevocationCacheKey(sessionId), '1', expirySeconds)
  }

  public async isRevoked(sessionId: string): Promise<boolean> {
    return this.cache().hasKey(adminSessionRevocationCacheKey(sessionId))
  }
}

export const resetAdminSessionRevocationCacheAdapterForTests = (): void => {
  cacheAdapter = undefined
}
