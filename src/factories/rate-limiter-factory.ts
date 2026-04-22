import { createSettings } from './settings-factory'
import { EWMARateLimiter } from '../utils/ewma-rate-limiter'
import { getCacheClient } from '../cache/client'
import { ICacheAdapter } from '../@types/adapters'
import { IRateLimiter } from '../@types/utils'
import { RedisAdapter } from '../adapters/redis-adapter'
import { SlidingWindowRateLimiter } from '../utils/sliding-window-rate-limiter'

let instance: IRateLimiter = undefined

export const rateLimiterFactory = () => {
  if (!instance) {
    const cache: ICacheAdapter = new RedisAdapter(getCacheClient())
    const settings = createSettings()
    const strategy = settings.limits?.rateLimiter?.strategy ?? 'ewma'

    if (strategy === 'sliding_window') {
      instance = new SlidingWindowRateLimiter(cache)
    } else {
      instance = new EWMARateLimiter(cache)
    }
  }


  return instance
}