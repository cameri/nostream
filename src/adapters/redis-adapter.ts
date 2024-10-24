import { CacheClient } from '../@types/cache'
import { createLogger } from '../factories/logger-factory'
import { ICacheAdapter } from '../@types/adapters'

const debug = createLogger('redis-adapter')

export class RedisAdapter implements ICacheAdapter {
  private connection: Promise<void>
  prefixKey: boolean | string

  public constructor(private readonly client: CacheClient) {
    this.connection = client.connect()

    this.connection.catch((error) => this.onClientError(error))

    this.client
      .on('connect', () => debug('connecting'))
      .on('ready', () => debug('connected'))
      .on('error', (error) => this.onClientError(error))
      .on('reconnecting', () => {
        debug('reconnecting')
        this.connection = new Promise((resolve, reject) => {
          const cleanup = () => {
            this.client.removeListener('ready', onReady)
            this.client.removeListener('error', onError)
          }

          const onError = (error: Error) => {
            cleanup()
            reject(error)
          }

          const onReady = () => {
            cleanup()
            resolve()
          }

          this.client.once('ready', onReady)

          this.client.once('error', onError)
        })
      })

    this.prefixKey = process.env.REDIS_PREFIX || false
  }

  private onClientError(error: Error) {
    console.error('Unable to connect to Redis.', error)
    // throw error
  }

  private addPrefixKey(key: string): string {
    if(this.prefixKey) {
      return `${this.prefixKey}:${key}`
    }

    return key
  }

  public async hasKey(key: string): Promise<boolean> {
    await this.connection
    debug('has %s key', key)
    return Boolean(this.client.exists(this.addPrefixKey(key)))
  }

  public async getKey(key: string): Promise<string> {
    await this.connection
    debug('get %s key', key)
    return this.client.get(this.addPrefixKey(key))
  }

  public async setKey(key: string, value: string): Promise<boolean> {
    await this.connection
    debug('get %s key', key)
    return 'OK' === await this.client.set(this.addPrefixKey(key), value)
  }

  public async removeRangeByScoreFromSortedSet(key: string, min: number, max: number): Promise<number> {
    await this.connection
    debug('remove %d..%d range from sorted set %s', min, max, key)
    return this.client.zRemRangeByScore(this.addPrefixKey(key), min, max)
  }

  public async getRangeFromSortedSet(key: string, min: number, max: number): Promise<string[]> {
    await this.connection
    debug('get %d..%d range from sorted set %s', min, max, key)
    return this.client.zRange(this.addPrefixKey(key), min, max)
  }

  public async setKeyExpiry(key: string, expiry: number): Promise<void> {
    await this.connection
    debug('expire at %d from sorted set %s', expiry, key)
    await this.client.expire(this.addPrefixKey(key), expiry)
  }

  public async addToSortedSet(
    key: string,
    set: Record<string, string>
  ): Promise<number> {
    await this.connection
    debug('add %o to sorted set %s', set, key)
    const members = Object
        .entries(set)
        .map(([value, score]) => ({ score: Number(score), value }))

    return this.client.zAdd(this.addPrefixKey(key), members)
  }

}