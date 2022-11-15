import { createClient, RedisClientOptions } from 'redis'
import { Cache } from '../@types/cache'

export const getCacheConfig = (): RedisClientOptions => ({
  url: `redis://${process.env.REDIS_USER}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
  password: process.env.REDIS_PASSWORD,
})

export const getCacheClient = (): Cache => {
  const config = getCacheConfig()

  const client = createClient(config)

  return client
}
