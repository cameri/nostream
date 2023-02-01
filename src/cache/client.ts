import { createClient, RedisClientOptions } from 'redis'
import { CacheClient } from '../@types/cache'
import { createLogger } from '../factories/logger-factory'


const debug = createLogger('cache-client')

export const getCacheConfig = (): RedisClientOptions => ({
  url: process.env.REDIS_URI ? process.env.REDIS_URI : `redis://${process.env.REDIS_USER}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  password: process.env.REDIS_PASSWORD,
})

let instance: CacheClient | undefined = undefined

export const getCacheClient = (): CacheClient => {
  if (!instance) {
    const config = getCacheConfig()
    debug('config: %o', config)
    instance = createClient(config)
  }

  return instance
}
