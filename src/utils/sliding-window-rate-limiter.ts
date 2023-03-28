import { IRateLimiter, IRateLimiterOptions } from '../@types/utils'
import { createLogger } from '../factories/logger-factory'
import { ICacheAdapter } from '../@types/adapters'

const debug = createLogger('sliding-window-rate-limiter')

export class SlidingWindowRateLimiter implements IRateLimiter {
  public constructor(
    private readonly cache: ICacheAdapter,
  ) {}

  public async hit(
    key: string,
    step: number,
    options: IRateLimiterOptions,
  ): Promise<boolean> {
    const timestamp = Date.now()
    const { period } = options

    const [,, entries] = await Promise.all([
      this.cache.removeRangeByScoreFromSortedSet(key, 0, timestamp - period),
      this.cache.addToSortedSet(key, { [`${timestamp}:${step}`]: timestamp.toString() }),
      this.cache.getRangeFromSortedSet(key, 0, -1),
      this.cache.setKeyExpiry(key, period),
    ])

    const hits = entries.reduce((acc, timestampAndStep) => acc + Number(timestampAndStep.split(':')[1]), 0)

    debug('hit count on %s bucket: %d', key, hits)

    return hits > options.rate
  }
}