import { CacheClient } from '../@types/cache'
import { createLogger } from '../factories/logger-factory'
import { ICacheAdapter } from '../@types/adapters'

const logger = createLogger('redis-adapter')

export class RedisAdapter implements ICacheAdapter {

  private connection: Promise<void>

  private scriptShas: Map<string, string> = new Map()

  public constructor(private readonly client: CacheClient) {
    this.connection = client.isOpen ? Promise.resolve() : client.connect()

    this.connection.catch((error) => this.onClientError(error))

    this.client
      .on('connect', () => logger('connecting'))
      .on('ready', () => logger('connected'))
      .on('error', (error) => this.onClientError(error))
      .on('reconnecting', () => {
        logger('reconnecting')
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
  }

  private onClientError(error: Error) {
    logger.error('Unable to connect to Redis.', error)
    // throw error
  }

  public async hasKey(key: string): Promise<boolean> {
    await this.connection
    logger('has %s key', key)
    return Boolean(this.client.exists(key))
  }

  public async getKey(key: string): Promise<string> {
    await this.connection
    logger('get %s key', key)
    return this.client.get(key)
  }

  public async setKey(key: string, value: string, expirySeconds?: number): Promise<boolean> {
    await this.connection
    logger('set %s key', key)
    if (typeof expirySeconds === 'number') {
      return 'OK' === (await this.client.set(key, value, { EX: expirySeconds }))
    }
    return 'OK' === (await this.client.set(key, value))
  }

  public async removeRangeByScoreFromSortedSet(key: string, min: number, max: number): Promise<number> {
    await this.connection
    logger('remove %d..%d range from sorted set %s', min, max, key)
    return this.client.zRemRangeByScore(key, min, max)
  }

  public async getRangeFromSortedSet(key: string, min: number, max: number): Promise<string[]> {
    await this.connection
    logger('get %d..%d range from sorted set %s', min, max, key)
    return this.client.zRange(key, min, max)
  }

  public async setKeyExpiry(key: string, expiry: number): Promise<void> {
    await this.connection
    logger('expire at %d from sorted set %s', expiry, key)
    await this.client.expire(key, expiry)
  }

  public async addToSortedSet(key: string, set: Record<string, string>): Promise<number> {
    await this.connection
    logger('add %o to sorted set %s', set, key)
    const members = Object.entries(set).map(([value, score]) => ({ score: Number(score), value }))

    return this.client.zAdd(key, members)
  }


  public async deleteKey(key: string): Promise<number> {
    await this.connection
    logger('delete %s key', key)
    return this.client.del(key)
  }

  public async getHKey(key: string, field: string): Promise<string> {
    await this.connection
    logger('get %s field for key %s', field, key)
    return await this.client.hGet(key, field) ?? ''
  }

  public async setHKey(key: string, fields: Record<string, string>): Promise<boolean> {
    await this.connection
    logger('set %s key', key)
    return await this.client.hSet(key, fields) >= 0
  }

  public async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    await this.connection
    if (!this.scriptShas.has(script)) {
      const sha = await this.client.scriptLoad(script)
      this.scriptShas.set(script, sha)
    }
    return await this.client.evalSha(this.scriptShas.get(script)!, { keys, arguments: args })
  }


}
