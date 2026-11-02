import { SubscriptionFilter } from '../@types/subscription'

export const ADMIN_OPS_STORAGE_MAX_KINDS = 20
export const ADMIN_OPS_STORAGE_MAX_WINDOW_SECONDS = 90 * 86_400
export const ADMIN_OPS_STORAGE_QUERY_TIMEOUT_MS = 5000

export interface AdminOpsStorageQuery {
  kinds: number[]
  since?: number
  until?: number
}

export const parseAdminOpsStorageQuery = (
  rawKinds: unknown,
  rawSince: unknown,
  rawUntil: unknown,
): { query?: AdminOpsStorageQuery; error?: string } => {
  if (typeof rawKinds !== 'string' || !rawKinds.trim()) {
    return { error: 'kinds query parameter is required (comma-separated event kinds)' }
  }

  const kinds = rawKinds
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))

  if (!kinds.length || kinds.some((kind) => !Number.isInteger(kind) || kind < 0 || kind > 65535)) {
    return { error: 'kinds must be a comma-separated list of integers between 0 and 65535' }
  }

  if (kinds.length > ADMIN_OPS_STORAGE_MAX_KINDS) {
    return { error: `at most ${ADMIN_OPS_STORAGE_MAX_KINDS} kinds are allowed per request` }
  }

  const uniqueKinds = [...new Set(kinds)]

  let since: number | undefined
  if (rawSince !== undefined && rawSince !== '') {
    since = Number(rawSince)
    if (!Number.isInteger(since) || since < 0) {
      return { error: 'since must be a non-negative unix timestamp in seconds' }
    }
  }

  let until: number | undefined
  if (rawUntil !== undefined && rawUntil !== '') {
    until = Number(rawUntil)
    if (!Number.isInteger(until) || until < 0) {
      return { error: 'until must be a non-negative unix timestamp in seconds' }
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const effectiveUntil = until ?? now
  const effectiveSince = since ?? effectiveUntil - 86_400

  if (effectiveSince > effectiveUntil) {
    return { error: 'since must be less than or equal to until' }
  }

  if (effectiveUntil - effectiveSince > ADMIN_OPS_STORAGE_MAX_WINDOW_SECONDS) {
    return { error: `time window must not exceed ${ADMIN_OPS_STORAGE_MAX_WINDOW_SECONDS} seconds` }
  }

  return {
    query: {
      kinds: uniqueKinds,
      since: effectiveSince,
      until: effectiveUntil,
    },
  }
}

export const buildStorageCountFilters = (query: AdminOpsStorageQuery): SubscriptionFilter[] => {
  const timeFilter: SubscriptionFilter = {}
  if (typeof query.since === 'number') {
    timeFilter.since = query.since
  }
  if (typeof query.until === 'number') {
    timeFilter.until = query.until
  }

  return query.kinds.map((kind) => ({
    ...timeFilter,
    kinds: [kind],
  }))
}
