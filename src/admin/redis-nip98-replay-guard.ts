import { INip98ReplayGuard } from '../@types/admin'
import { CacheClient } from '../@types/cache'

export class RedisNip98ReplayGuard implements INip98ReplayGuard {
  public constructor(private readonly getClient: () => CacheClient) {}

  public async registerEventId(eventId: string, ttlSeconds: number): Promise<boolean> {
    const client = this.getClient()
    if (!client.isOpen) {
      await client.connect()
    }

    const result = await client.set(`nip98:seen:${eventId}`, '1', { NX: true, EX: ttlSeconds })

    return result === 'OK'
  }
}
