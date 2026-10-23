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

const FETCH_BUCKET_SCRIPT = `
return redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
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

const mergeHitRows = (buckets: ModerationRateLimitHitRow[][]): ModerationRateLimitHitRow[] => {
  const totals = new Map<string, number>()
  for (const bucket of buckets) {
    for (const row of bucket) {
      totals.set(row.key, (totals.get(row.key) ?? 0) + row.hits)
    }
  }

  return [...totals.entries()]
    .map(([key, hits]) => ({ key, hits }))
    .sort((a, b) => b.hits - a.hits)
}

const fetchAggregatedHits = async (
  cache: ICacheAdapter,
  prefix: string,
  limit: number,
  windowHours: number,
): Promise<ModerationRateLimitHitRow[]> => {
  const clamped = Math.min(Math.max(Math.floor(limit), 1), 100)
  const suffixes = listDayBucketSuffixes(windowHours)
  const buckets = await Promise.all(
    suffixes.map(async (suffix) => {
      const key = `${prefix}:${suffix}`
      const result = await cache.eval(FETCH_BUCKET_SCRIPT, [key], [])
      return parseBucketRows(result)
    }),
  )

  return mergeHitRows(buckets).slice(0, clamped)
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
