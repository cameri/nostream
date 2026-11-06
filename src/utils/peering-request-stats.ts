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

const READ_SCRIPT = `
local raw = redis.call('HGETALL', KEYS[1])
if #raw == 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
end
return raw
`

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

interface PendingStats {
  requests: number
  eventsServed: number
  lastRequestAt?: string
  lastRequestType?: string
}

const ACCOUNTING_FLUSH_DELAY_MS = 250
const MAX_CONCURRENT_ACCOUNTING_WRITES = 25

export class PeeringRequestStatsStore {
  private pending = new Map<string, PendingStats>()
  private flushTimer: NodeJS.Timeout | undefined
  private flushPromise: Promise<void> | undefined

  public constructor(private readonly cache: ICacheAdapter) {}

  public recordRequest(pubkey: string, type: string): void {
    this.enqueue(pubkey, {
      requests: 1,
      eventsServed: 0,
      lastRequestAt: new Date().toISOString(),
      lastRequestType: type,
    })
  }

  public addEventsServed(pubkey: string, count: number): void {
    if (count <= 0) {
      return
    }

    this.enqueue(pubkey, { requests: 0, eventsServed: count })
  }

  public async list(): Promise<PeeringRequestStats[]> {
    // Flush the bounded pending batch so a dashboard poll sees the latest
    // counters without adding one Redis write per delivered event.
    await this.flushPending()

    let pubkeys: string[]
    try {
      pubkeys = await this.cache.getSetMembers(PEERING_REQUEST_STATS_INDEX_KEY)
    } catch (error) {
      // A stats-index read failure must not hide the Peering table's sync rows.
      logger.warn('failed to read peering request stats index: %o', error)
      return []
    }

    const stats: PeeringRequestStats[] = []

    for (const pubkey of pubkeys) {
      try {
        // Reading and pruning are one script: a request may recreate the hash
        // between an empty HGETALL and a separate SREM, which would otherwise
        // drop fresh counters from the index.
        const parsed = parseStats(
          await this.cache.eval(READ_SCRIPT, [statsKey(pubkey), PEERING_REQUEST_STATS_INDEX_KEY], [pubkey]),
        )
        if (parsed) {
          stats.push(parsed)
        }
      } catch (error) {
        logger.warn('failed to read peering request stats for %s: %o', pubkey, error)
      }
    }

    return stats.sort((left, right) => left.pubkey.localeCompare(right.pubkey))
  }

  /** Flush pending counters now. Exposed for admin reads and deterministic tests. */
  public async flushPending(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    if (this.flushPromise) {
      await this.flushPromise
    }

    if (this.pending.size === 0) {
      return
    }

    const batch = this.pending
    this.pending = new Map()
    const entries = [...batch.entries()]

    this.flushPromise = (async () => {
      for (let offset = 0; offset < entries.length; offset += MAX_CONCURRENT_ACCOUNTING_WRITES) {
        await Promise.all(
          entries.slice(offset, offset + MAX_CONCURRENT_ACCOUNTING_WRITES).map(([pubkey, stats]) =>
            this.record(pubkey, stats.requests, stats.eventsServed, {
              at: stats.lastRequestAt,
              type: stats.lastRequestType,
            }),
          ),
        )
      }
    })()

    try {
      await this.flushPromise
    } finally {
      this.flushPromise = undefined
      if (this.pending.size > 0) {
        this.scheduleFlush()
      }
    }
  }

  private enqueue(pubkey: string, delta: PendingStats): void {
    const normalized = pubkey.toLowerCase()
    const current = this.pending.get(normalized) ?? { requests: 0, eventsServed: 0 }

    this.pending.set(normalized, {
      requests: current.requests + delta.requests,
      eventsServed: current.eventsServed + delta.eventsServed,
      ...(delta.lastRequestAt
        ? { lastRequestAt: delta.lastRequestAt }
        : current.lastRequestAt
          ? { lastRequestAt: current.lastRequestAt }
          : {}),
      ...(delta.lastRequestType
        ? { lastRequestType: delta.lastRequestType }
        : current.lastRequestType
          ? { lastRequestType: current.lastRequestType }
          : {}),
    })

    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushPromise) {
      return
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushPending()
    }, ACCOUNTING_FLUSH_DELAY_MS)
    this.flushTimer.unref()
  }

  private async record(
    pubkey: string,
    requests: number,
    eventsServed: number,
    last?: { at?: string; type?: string },
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
