import { ICacheAdapter } from '../@types/adapters'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('peering-request-stats')

export const PEERING_REQUEST_STATS_INDEX_KEY = 'admin:peering:requests:index'
export const PEERING_REQUEST_STATS_TTL_SECONDS = 7 * 24 * 60 * 60

export interface PeeringRequestStats {
  pubkey: string
  requests: number
  eventsServed: number
  lastRequestAt?: string
  lastRequestType?: string
}

const statsKey = (pubkey: string): string => `admin:peering:requests:${pubkey.toLowerCase()}`

const RECORD_SCRIPT = `
local key = KEYS[1]
local index = KEYS[2]
redis.call('HINCRBY', key, 'requests', tonumber(ARGV[1]))
redis.call('HINCRBY', key, 'eventsServed', tonumber(ARGV[2]))
redis.call('HSET', key, 'pubkey', ARGV[3])
if ARGV[4] ~= '' then
  redis.call('HSET', key, 'lastRequestAt', ARGV[4], 'lastRequestType', ARGV[5])
end
redis.call('EXPIRE', key, tonumber(ARGV[6]))
redis.call('SADD', index, ARGV[3])
redis.call('EXPIRE', index, tonumber(ARGV[6]))
return 1
`

const READ_SCRIPT = `return redis.call('HGETALL', KEYS[1])`

const parseStats = (raw: unknown): PeeringRequestStats | undefined => {
  if (!Array.isArray(raw)) {
    return undefined
  }

  const fields = new Map<string, string>()
  for (let index = 0; index + 1 < raw.length; index += 2) {
    fields.set(String(raw[index]), String(raw[index + 1]))
  }

  const pubkey = fields.get('pubkey')
  if (!pubkey) {
    return undefined
  }

  const requests = Number(fields.get('requests') ?? 0)
  const eventsServed = Number(fields.get('eventsServed') ?? 0)

  return {
    pubkey: pubkey.toLowerCase(),
    requests: Number.isFinite(requests) ? requests : 0,
    eventsServed: Number.isFinite(eventsServed) ? eventsServed : 0,
    ...(fields.get('lastRequestAt') ? { lastRequestAt: fields.get('lastRequestAt') } : {}),
    ...(fields.get('lastRequestType') ? { lastRequestType: fields.get('lastRequestType') } : {}),
  }
}

export class PeeringRequestStatsStore {
  public constructor(private readonly cache: ICacheAdapter) {}

  public async recordRequest(pubkey: string, type: string): Promise<void> {
    await this.record(pubkey, 1, 0, { at: new Date().toISOString(), type })
  }

  public async addEventsServed(pubkey: string, count: number): Promise<void> {
    if (count <= 0) {
      return
    }

    await this.record(pubkey, 0, count)
  }

  public async list(): Promise<PeeringRequestStats[]> {
    const pubkeys = await this.cache.getSetMembers(PEERING_REQUEST_STATS_INDEX_KEY)
    const stats: PeeringRequestStats[] = []

    for (const pubkey of pubkeys) {
      try {
        const parsed = parseStats(await this.cache.eval(READ_SCRIPT, [statsKey(pubkey)], []))
        if (parsed) {
          stats.push(parsed)
        }
      } catch (error) {
        logger.warn('failed to read peering request stats for %s: %o', pubkey, error)
      }
    }

    return stats.sort((left, right) => left.pubkey.localeCompare(right.pubkey))
  }

  private async record(
    pubkey: string,
    requests: number,
    eventsServed: number,
    last?: { at: string; type: string },
  ): Promise<void> {
    try {
      await this.cache.eval(
        RECORD_SCRIPT,
        [statsKey(pubkey), PEERING_REQUEST_STATS_INDEX_KEY],
        [
          String(requests),
          String(eventsServed),
          pubkey.toLowerCase(),
          last?.at ?? '',
          last?.type ?? '',
          String(PEERING_REQUEST_STATS_TTL_SECONDS),
        ],
      )
    } catch (error) {
      // Accounting must never fail the peer request it is describing.
      logger.warn('failed to record peering request stats for %s: %o', pubkey, error)
    }
  }
}
