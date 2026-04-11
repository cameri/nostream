import { IRateLimiter, IRateLimiterOptions } from '../@types/utils'
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

      if R_new > rate then
          return 1
      else
          return 0
      end
    `,
  }

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
  ): Promise<boolean> {
    const { rate, period } = options

    const result = await this.cache.eval(rateLimitScript.SCRIPT,
       [key],
       [Date.now().toString(), rate.toString(), period.toString(), step.toString()]
    )

    debug('ewma rate limited on %s bucket: %s', key, result ? 'yes' : 'no')

    return result === 1
  }

}
