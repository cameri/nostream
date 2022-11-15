import { createClient, RedisClientOptions } from 'redis'
import { CacheClient } from '../@types/cache'

export const getCacheConfig = (): RedisClientOptions => ({
  url: `redis://${process.env.REDIS_USER}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  password: process.env.REDIS_PASSWORD,
})

let instance: CacheClient = undefined

export const getCacheClient = (): CacheClient => {
  if (!instance) {
    const config = getCacheConfig()

    instance = createClient(config)
  }

  return instance
}
