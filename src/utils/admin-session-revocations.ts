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

/** A stalled Redis connection must not leave an admin request waiting, so each cache call gets a deadline. */
export const ADMIN_SESSION_REVOCATION_TIMEOUT_MS = 2000

const withTimeout = <T>(operation: () => Promise<T>, timeoutMs: number, name: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs} ms`)), timeoutMs)

    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })

export const adminSessionRevocationCacheKey = (sessionId: string): string => `admin:session:revoked:${sessionId}`

/**
 * Revoked session ids live in the shared cache, so a logout handled by one worker ends the session on all of
 * them. An entry only has to outlast the token, which is rejected on its own once it has expired.
 */
export class CacheAdminSessionRevocations implements IAdminSessionRevocations {
  public constructor(
    private readonly cache: () => ICacheAdapter = getCache,
    private readonly timeoutMs: number = ADMIN_SESSION_REVOCATION_TIMEOUT_MS,
  ) {}

  public async revoke(sessionId: string, ttlSeconds: number): Promise<void> {
    const expirySeconds = Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 1

    await withTimeout(
      () => this.cache().setKey(adminSessionRevocationCacheKey(sessionId), '1', expirySeconds),
      this.timeoutMs,
      'revoking the admin session',
    )
  }

  public async isRevoked(sessionId: string): Promise<boolean> {
    return withTimeout(
      () => this.cache().hasKey(adminSessionRevocationCacheKey(sessionId)),
      this.timeoutMs,
      'checking the admin session revocation',
    )
  }
}

export const resetAdminSessionRevocationCacheAdapterForTests = (): void => {
  cacheAdapter = undefined
}
