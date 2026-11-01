import { Knex } from 'knex'

export const ADMIN_MODERATION_STATS_DEFAULT_WINDOW_HOURS = 168
export const ADMIN_MODERATION_STATS_MAX_WINDOW_HOURS = 720
export const ADMIN_MODERATION_STATS_QUERY_TIMEOUT_MS = 5000

export interface ModerationPublisherRow {
  pubkey: string
  eventCount: number
}

export interface ModerationClientIpRow {
  ip: string
  eventCount: number
}

export const parseModerationStatsWindowHours = (raw: unknown): { hours?: number; error?: string } => {
  if (raw === undefined || raw === '') {
    return { hours: ADMIN_MODERATION_STATS_DEFAULT_WINDOW_HOURS }
  }

  const hours = Number(raw)
  if (!Number.isInteger(hours) || hours < 1 || hours > ADMIN_MODERATION_STATS_MAX_WINDOW_HOURS) {
    return {
      error: `windowHours must be an integer between 1 and ${ADMIN_MODERATION_STATS_MAX_WINDOW_HOURS}`,
    }
  }

  return { hours }
}

export const parseModerationStatsLimit = (raw: unknown): number => {
  if (raw === undefined || raw === '') {
    return 20
  }

  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return 20
  }

  return limit
}

// `first_seen` is a timestamp without time zone written in UTC. Build the
// cutoff from the unix timestamp in SQL: a JS Date is sent with the process's
// local offset, which PostgreSQL ignores for timestamp-without-time-zone
// comparisons, shifting the window by the difference between the two zones.
const firstSeenCutoff = (db: Knex, sinceUnixSeconds: number) =>
  db.raw(`to_timestamp(?) at time zone 'UTC'`, [sinceUnixSeconds])

export const queryTopPublishingPubkeys = async (
  db: Knex,
  sinceUnixSeconds: number,
  limit: number,
): Promise<ModerationPublisherRow[]> => {
  const result = await db('events')
    .select(db.raw(`encode(event_pubkey, 'hex') as pubkey`))
    .count('* as eventCount')
    .whereNull('deleted_at')
    .where('first_seen', '>=', firstSeenCutoff(db, sinceUnixSeconds))
    .groupBy('event_pubkey')
    .orderBy('eventCount', 'desc')
    .limit(limit)
    .timeout(ADMIN_MODERATION_STATS_QUERY_TIMEOUT_MS, { cancel: true })

  return (result as unknown as Array<{ pubkey: string; eventCount: string | number }>).map((row) => ({
    pubkey: String(row.pubkey),
    eventCount: Number(row.eventCount ?? 0),
  }))
}

export const queryTopClientIps = async (
  db: Knex,
  sinceUnixSeconds: number,
  limit: number,
): Promise<ModerationClientIpRow[]> => {
  const result = await db('events')
    .select(db.raw(`host(remote_address) as ip`))
    .count('* as eventCount')
    .whereNull('deleted_at')
    .whereNotNull('remote_address')
    .where('first_seen', '>=', firstSeenCutoff(db, sinceUnixSeconds))
    .groupBy('remote_address')
    .orderBy('eventCount', 'desc')
    .limit(limit)
    .timeout(ADMIN_MODERATION_STATS_QUERY_TIMEOUT_MS, { cancel: true })

  return (result as unknown as Array<{ ip: string; eventCount: string | number }>).map((row) => ({
    ip: String(row.ip),
    eventCount: Number(row.eventCount ?? 0),
  }))
}
