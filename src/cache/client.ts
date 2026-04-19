import { createClient, RedisClientOptions } from 'redis'
import { CacheClient } from '../@types/cache'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('cache-client')

const redactRedisUrlCredentials = (url: string): string => {
  try {
    const parsedUrl = new URL(url)

    if (!parsedUrl.username && !parsedUrl.password) {
      return url
    }

    parsedUrl.username = parsedUrl.username ? '***' : ''
    parsedUrl.password = parsedUrl.password ? '***' : ''

    return parsedUrl.toString()
  } catch {
    return url
  }
}

export const getCacheConfig = (): RedisClientOptions => {
  if (process.env.REDIS_URI) {
    return {
      url: process.env.REDIS_URI,
      ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
    }
  }

  const hasPassword = Boolean(process.env.REDIS_PASSWORD)
  const host = process.env.REDIS_HOST
  const port = process.env.REDIS_PORT

  if (hasPassword) {
    const username = process.env.REDIS_USER ?? 'default'

    return {
      url: `redis://${host}:${port}`,
      username,
      password: process.env.REDIS_PASSWORD,
    }
  }

  return {
    url: `redis://${host}:${port}`,
  }
}

let instance: CacheClient | undefined = undefined

export const getCacheClient = (): CacheClient => {
  if (!instance) {
    const config = getCacheConfig()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _, ...loggableConfig } = config
    logger('config: %o', {
      ...loggableConfig,
      ...(loggableConfig.url ? { url: redactRedisUrlCredentials(loggableConfig.url) } : {}),
    })
    instance = createClient(config)
  }

  return instance
}

export const closeCacheClient = async (): Promise<void> => {
  if (instance?.isOpen) {
    await instance.disconnect()
    instance = undefined
  }
}
