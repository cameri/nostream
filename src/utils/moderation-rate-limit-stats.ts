import { ICacheAdapter } from '../@types/adapters'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('moderation-rate-limit-stats')

const PUBKEY_HITS_KEY = 'admin:moderation:rate-limit:pubkeys'
const IP_HITS_KEY = 'admin:moderation:rate-limit:ips'
const STATS_TTL_SECONDS = 7 * 86400

const INCREMENT_SCRIPT = `
redis.call('ZINCRBY', KEYS[1], 1, ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`

const FETCH_TOP_SCRIPT = `
return redis.call('ZREVRANGE', KEYS[1], 0, ARGV[1], 'WITHSCORES')
`

export interface ModerationRateLimitHitRow {
  key: string
  hits: number
}

export const recordModerationRateLimitHitSafely = async (
  cache: ICacheAdapter | undefined,
  fields: { pubkey: string; ip?: string },
): Promise<void> => {
  if (!cache) {
    return
  }

  try {
    await cache.eval(INCREMENT_SCRIPT, [PUBKEY_HITS_KEY], [fields.pubkey.toLowerCase(), String(STATS_TTL_SECONDS)])
    if (fields.ip) {
      await cache.eval(INCREMENT_SCRIPT, [IP_HITS_KEY], [fields.ip, String(STATS_TTL_SECONDS)])
    }
  } catch (error) {
    logger.warn('failed to record moderation rate-limit hit: %o', error)
  }
}

const fetchTopHits = async (cache: ICacheAdapter, key: string, limit: number): Promise<ModerationRateLimitHitRow[]> => {
  const clamped = Math.min(Math.max(Math.floor(limit), 1), 100)
  const result = (await cache.eval(FETCH_TOP_SCRIPT, [key], [String(clamped - 1)])) as string[] | null

  if (!Array.isArray(result) || !result.length) {
    return []
  }

  const rows: ModerationRateLimitHitRow[] = []
  for (let index = 0; index < result.length; index += 2) {
    rows.push({ key: result[index], hits: Number(result[index + 1] ?? 0) })
  }

  return rows
}

/** Top rate-limit hits recorded in Redis (7-day TTL refreshed on each hit). */
export const listModerationRateLimitHits = async (
  cache: ICacheAdapter,
  limit: number,
): Promise<{ pubkeys: ModerationRateLimitHitRow[]; ips: ModerationRateLimitHitRow[] }> => {
  const [pubkeys, ips] = await Promise.all([
    fetchTopHits(cache, PUBKEY_HITS_KEY, limit),
    fetchTopHits(cache, IP_HITS_KEY, limit),
  ])

  return { pubkeys, ips }
}
