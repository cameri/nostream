import { IRateLimiter, IRateLimiterOptions } from '../@types/utils'
import { createLogger } from '../factories/logger-factory'
import { ICacheAdapter } from '../@types/adapters'

const logger = createLogger('sliding-window-rate-limiter')

const SLIDING_WINDOW_RATE_LIMITER_LUA_SCRIPT = `
      local key = KEYS[1]
      local timestamp = tonumber(ARGV[1])
      local period = tonumber(ARGV[2])
      local step = tonumber(ARGV[3])
      local max_rate = tonumber(ARGV[4])

      local windowStart = timestamp - period

      redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)

      local entries = redis.call('ZRANGE', key, 0, -1)
      local hits = 0
      for i=1, #entries do
          local step_str = string.match(entries[i], "^[^:]+:([^:]+)")
          if step_str then
              local entry_step = tonumber(step_str)
              if entry_step then
                  hits = hits + entry_step
              end
          end
      end

      if hits + step > max_rate then
          return 1
      end

      local base_member = timestamp .. ':' .. step
      local member = base_member
      local counter = 0
      while redis.call('ZSCORE', key, member) do
          counter = counter + 1
          member = base_member .. ':' .. counter
      end

      redis.call('ZADD', key, timestamp, member)
      redis.call('PEXPIRE', key, period)

      return 0
`

export class SlidingWindowRateLimiter implements IRateLimiter {
  public constructor(
    private readonly cache: ICacheAdapter,
  ) { }

  public async hit(key: string, step: number, options: IRateLimiterOptions): Promise<boolean> {
    const timestamp = Date.now()
    const { period, rate } = options

    const result = await this.cache.eval(SLIDING_WINDOW_RATE_LIMITER_LUA_SCRIPT, [key], [
      timestamp.toString(),
      period.toString(),
      step.toString(),
      rate.toString(),
    ])

    const isRateLimited = result === 1 || result === '1'

    logger('hit on %s bucket: is rate limited? %s', key, isRateLimited)

    return isRateLimited
  }
}
