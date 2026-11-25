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

  public async revoke(sessionId: string, ttlSeconds: number): Promise<boolean> {
    // A replay that was valid when it started can still have its write land up to the timeout later, so the entry
    // has to outlast the token by that long. Otherwise the entry could expire first and the replay would win.
    const writeWindowSeconds = Math.ceil(this.timeoutMs / 1000)
    const expirySeconds = (Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 1) + writeWindowSeconds

    // Set only if absent, in one step, so that of several logouts of the same session at once exactly one is told
    // that it revoked it. The entry keeps the expiry of the first revocation, which is when the token ends anyway.
    return withTimeout(
      () => this.cache().setKeyIfNotExists(adminSessionRevocationCacheKey(sessionId), '1', expirySeconds),
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
