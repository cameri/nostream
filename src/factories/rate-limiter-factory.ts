import { getCacheClient } from '../cache/client'
import { ICacheAdapter } from '../@types/adapters'
import { IRateLimiter } from '../@types/utils'
import { RedisAdapter } from '../adapters/redis-adapter'
import { SlidingWindowRateLimiter } from '../utils/sliding-window-rate-limiter'

let instance: IRateLimiter = undefined

export const slidingWindowRateLimiterFactory = () => {
  if (!instance) {
    const cache: ICacheAdapter = new RedisAdapter(getCacheClient())
    instance = new SlidingWindowRateLimiter(cache)
  }

  return instance
}
