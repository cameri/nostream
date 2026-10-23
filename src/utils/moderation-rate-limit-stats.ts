import { randomBytes } from 'node:crypto'

import { ICacheAdapter } from '../@types/adapters'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('moderation-rate-limit-stats')

const PUBKEY_HITS_PREFIX = 'admin:moderation:rate-limit:pubkeys'
const IP_HITS_PREFIX = 'admin:moderation:rate-limit:ips'
const STATS_RETENTION_DAYS = 7

const INCREMENT_BUCKET_SCRIPT = `
redis.call('ZINCRBY', KEYS[1], 1, ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`

const AGGREGATE_TOP_SCRIPT = `
local dest = KEYS[1]
local sourceCount = #KEYS - 1
if sourceCount < 1 then
  return {}
end
redis.call('ZUNIONSTORE', dest, sourceCount, unpack(KEYS, 2))
local rows = redis.call('ZREVRANGE', dest, 0, ARGV[1], 'WITHSCORES')
redis.call('DEL', dest)
return rows
`

export interface ModerationRateLimitHitRow {
  key: string
  hits: number
}

const hasEval = (cache: ICacheAdapter): cache is ICacheAdapter & { eval: ICacheAdapter['eval'] } =>
  typeof (cache as { eval?: unknown }).eval === 'function'

export const utcDayBucketSuffix = (unixMs: number): string => {
  const date = new Date(unixMs)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

const bucketKey = (prefix: string, unixMs: number): string => `${prefix}:${utcDayBucketSuffix(unixMs)}`

const bucketTtlSeconds = (): number => STATS_RETENTION_DAYS * 86400

const listDayBucketSuffixes = (windowHours: number, nowMs = Date.now()): string[] => {
  const windowDays = Math.max(1, Math.ceil(windowHours / 24))
  const dayCount = Math.min(windowDays, STATS_RETENTION_DAYS)
  const suffixes: string[] = []
  for (let offset = 0; offset < dayCount; offset += 1) {
    suffixes.push(utcDayBucketSuffix(nowMs - offset * 86400000))
  }
  return suffixes
}

export const recordModerationRateLimitHitSafely = async (
  cache: ICacheAdapter | undefined,
  fields: { pubkey: string; ip?: string },
): Promise<void> => {
  if (!cache || !hasEval(cache)) {
    return
  }

  const bucket = bucketKey(PUBKEY_HITS_PREFIX, Date.now())
  const ttl = String(bucketTtlSeconds())

  try {
    await cache.eval(INCREMENT_BUCKET_SCRIPT, [bucket], [fields.pubkey.toLowerCase(), ttl])
    if (fields.ip) {
      const ipBucket = bucketKey(IP_HITS_PREFIX, Date.now())
      await cache.eval(INCREMENT_BUCKET_SCRIPT, [ipBucket], [fields.ip, ttl])
    }
  } catch (error) {
    logger.warn('failed to record moderation rate-limit hit: %o', error)
  }
}

const parseBucketRows = (result: unknown): ModerationRateLimitHitRow[] => {
  if (!Array.isArray(result) || !result.length) {
    return []
  }

  const rows: ModerationRateLimitHitRow[] = []
  for (let index = 0; index < result.length; index += 2) {
    rows.push({ key: String(result[index]), hits: Number(result[index + 1] ?? 0) })
  }
  return rows
}

const fetchAggregatedHits = async (
  cache: ICacheAdapter,
  prefix: string,
  limit: number,
  windowHours: number,
): Promise<ModerationRateLimitHitRow[]> => {
  const clamped = Math.min(Math.max(Math.floor(limit), 1), 100)
  const suffixes = listDayBucketSuffixes(windowHours)
  if (!suffixes.length) {
    return []
  }

  const destKey = `${prefix}:__agg:${randomBytes(8).toString('hex')}`
  const sourceKeys = suffixes.map((suffix) => `${prefix}:${suffix}`)
  const result = await cache.eval(AGGREGATE_TOP_SCRIPT, [destKey, ...sourceKeys], [String(clamped - 1)])

  return parseBucketRows(result).slice(0, clamped)
}

/** Top rate-limit hits in Redis daily buckets within the requested window. */
export const listModerationRateLimitHits = async (
  cache: ICacheAdapter,
  limit: number,
  windowHours = STATS_RETENTION_DAYS * 24,
): Promise<{ pubkeys: ModerationRateLimitHitRow[]; ips: ModerationRateLimitHitRow[] }> => {
  const [pubkeys, ips] = await Promise.all([
    fetchAggregatedHits(cache, PUBKEY_HITS_PREFIX, limit, windowHours),
    fetchAggregatedHits(cache, IP_HITS_PREFIX, limit, windowHours),
  ])

  return { pubkeys, ips }
}
