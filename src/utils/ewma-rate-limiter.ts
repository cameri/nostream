import { IRateLimiter, IRateLimiterOptions, IRateLimiterResult } from '../@types/utils'
import { createLogger } from '../factories/logger-factory'
import { ICacheAdapter } from '../@types/adapters'

const debug = createLogger('ewma-rate-limiter')

const rateLimitScript = {
    NUMBER_OF_KEYS: 1,
    SCRIPT: `
      local key = KEYS[1]
      local timestamp = tonumber(ARGV[1])
      local rate = tonumber(ARGV[2])
      local period = tonumber(ARGV[3])
      local R_old = tonumber(redis.call('HGET', key, 'rate')) or 0
      local T_old = tonumber(redis.call('HGET', key, 'timestamp')) or timestamp

      local deltaT = timestamp - T_old
      local lambda = math.log(2) / period
      local R_new  = R_old * math.exp(-lambda * deltaT) + tonumber(ARGV[4])

      redis.call('HSET', key, 'rate', R_new, 'timestamp', timestamp)
      redis.call('EXPIRE', key, math.ceil(period / 1000))

      -- A Lua number reaches the client truncated to an integer, and the score
      -- is a float: tostring is what keeps the fraction the caller needs to
      -- tell 6.4 hits from 24.
      return tostring(R_new)
    `,
  }

// Every limiter key is namespaced by strategy, because the window layouts are
// not interchangeable: a sliding window stores a sorted set under a key named
// `<identity>:<bucket>:<period>`, while EWMA stores a hash under the same name.
// The strategies share Redis and an operator can switch between them (and 2.x
// shipped only the sliding window), so reading a key this strategy did not
// write makes the script fail with WRONGTYPE on every request that hits it -
// and the failure path is the hot path, per connection and per message.
//
// A prefix, rather than deleting a key of the wrong type, keeps both strategies'
// data intact: switching back to sliding_window resumes its window instead of
// starting from zero.
export const EWMA_KEY_PREFIX = 'ewma:'

export const ewmaKey = (key: string): string => `${EWMA_KEY_PREFIX}${key}`

export const calculateEWMA = (
  rOld: number,
  deltaT: number,
  period: number,
  step: number
): number => {
  const lambda = Math.log(2) / period
  return rOld * Math.exp(-lambda * deltaT) + step
}

export class EWMARateLimiter implements IRateLimiter {
  public constructor(
    private readonly cache: ICacheAdapter,
  ) {}

  public async hit(
    key: string,
    step: number,
    options: IRateLimiterOptions,
  ): Promise<IRateLimiterResult> {
    const { rate, period } = options

    const result = await this.cache.eval(rateLimitScript.SCRIPT,
       [ewmaKey(key)],
       [Date.now().toString(), rate.toString(), period.toString(), step.toString()]
    )

    // A null/undefined answer means the script returned nil, which is a protocol
    // disagreement, not a score of zero: reading it as "allowed" would silently
    // disable the limiter.
    if (typeof result !== 'string' && typeof result !== 'number') {
        throw new Error(`ewma rate limiter returned no score: ${String(result)}`)
    }

    const score = Number(result)
    if (!Number.isFinite(score)) {
        throw new Error(`ewma rate limiter returned a non-numeric score: ${String(result)}`)
    }

    const limited = score > rate

    debug('ewma rate limited on %s bucket: %s (score %d, rate %d)', key, limited ? 'yes' : 'no', score, rate)

    if (!limited) {
        return { limited: false }
    }

    // `period` is the half-life, not the wait: the score decays as
    // `score * 2^(-t/period)`, so it takes `period * log2(score / target)` to
    // fall back to `target`. Reporting `period` understates a four-times
    // overrun by half (rate 6, score 24, period 60 s: ~136 s, not 60 s).
    //
    // The target is `rate - step`, not `rate`: the script adds this hit's step
    // before comparing, so a score that has decayed to exactly `rate` still
    // exceeds it. With no headroom (`rate <= step`) no amount of decay admits
    // another hit, and the key's TTL is what eventually clears it.
    const headroom = rate - step
    return {
        limited: true,
        retryAfterMs: headroom > 0
            ? Math.max(1, Math.ceil(period * Math.log2(score / headroom)))
            : Math.max(1, Math.ceil(period)),
    }
  }

}
