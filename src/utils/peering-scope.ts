import { EventKindsRange, PeeringScope } from '../@types/settings'
import { SubscriptionFilter } from '../@types/subscription'
import { EventKinds } from '../constants/base'

export const MAX_PEERING_KIND = 65535

/**
 * Overlap used when the live subscription starts. NIP-01 REQ has no "future
 * only" mode, so ask for a short tail as well: an event published while
 * negentropy runs is delivered either by reconciliation or by the live
 * subscription, and duplicate inserts are harmless.
 */
export const PEERING_LIVE_OVERLAP_SECONDS = 60

/**
 * Keep each filter under the default peer maxFilterValues (10,000) with
 * headroom. A broad scope such as `[[0, 65535]]` must become several filters
 * or the source rejects the whole request before any history is synced.
 */
export const PEERING_MAX_FILTER_KINDS = 5000

/** Expand `[min, max]` scopes into the explicit kind list NIP-01 filters require. */
export const expandPeeringKinds = (kinds: (EventKinds | EventKindsRange)[]): number[] => {
  const expanded = new Set<number>()

  for (const kind of kinds) {
    if (typeof kind === 'number') {
      expanded.add(kind)
      continue
    }

    for (let value = kind[0]; value <= kind[1]; value++) {
      expanded.add(value)
    }
  }

  return [...expanded].sort((left, right) => left - right)
}

const scopeKinds = (scope: PeeringScope): number[] => expandPeeringKinds(scope.kinds)

const chunk = <T>(values: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size))
  }

  return chunks
}

const applyScopeTime = (filter: SubscriptionFilter, scope: PeeringScope, nowSeconds: number): SubscriptionFilter => {
  if (typeof scope.windowSeconds === 'number') {
    filter.since = Math.max(0, nowSeconds - scope.windowSeconds)
  } else {
    if (typeof scope.since === 'number') {
      filter.since = scope.since
    }

    if (typeof scope.until === 'number') {
      filter.until = scope.until
    }
  }

  return filter
}

/**
 * The filter used to reconcile one advertised scope when it fits in one
 * request. A rolling window becomes an absolute `since` at the moment of the
 * reconciliation; `limit` is never set because negentropy compares whole sets
 * rather than pages.
 */
export const peeringScopeToFilter = (scope: PeeringScope, nowSeconds: number): SubscriptionFilter =>
  applyScopeTime({ kinds: scopeKinds(scope) }, scope, nowSeconds)

/**
 * Reconcile filters for one scope. Wide kind ranges are split into chunks so
 * each request stays within a peer's `maxFilterValues`.
 */
export const peeringScopeToFilters = (
  scope: PeeringScope,
  nowSeconds: number,
  maxKinds = PEERING_MAX_FILTER_KINDS,
): SubscriptionFilter[] =>
  chunk(scopeKinds(scope), Math.max(1, maxKinds)).map((kinds) => applyScopeTime({ kinds }, scope, nowSeconds))

const isCurrentScope = (scope: PeeringScope, nowSeconds: number): boolean =>
  typeof scope.until !== 'number' || scope.until >= nowSeconds

/**
 * Filters for the long-lived subscription. A scope whose `until` already passed
 * is historical only and gets no live subscription. The subscription starts at
 * the recent overlap, but never earlier than the scope itself: a 5-second
 * rolling window must not import the last 60 seconds by accident.
 */
export const peeringScopesToLiveFilters = (
  scopes: PeeringScope[],
  nowSeconds: number,
  overlapSeconds = PEERING_LIVE_OVERLAP_SECONDS,
): SubscriptionFilter[] =>
  scopes
    .filter((scope) => isCurrentScope(scope, nowSeconds))
    .flatMap((scope) =>
      peeringScopeToFilters(scope, nowSeconds).map((filter) => {
        const overlapSince = Math.max(0, nowSeconds - overlapSeconds)

        if (typeof scope.windowSeconds === 'number') {
          // The scope's own cutoff is already the newer of the two for short
          // windows; for long windows the overlap is the newer one.
          filter.since = Math.max(filter.since ?? 0, overlapSince)
          delete filter.until
        } else {
          filter.since = Math.max(filter.since ?? 0, overlapSince)
        }

        return filter
      }),
    )

export const isCurrentPeeringScope = (scope: PeeringScope, nowSeconds: number): boolean =>
  isCurrentScope(scope, nowSeconds)

/**
 * Splits one reconciliation filter at its midpoint in time when a peer rejects
 * the set as too large. Returns undefined when the range cannot be split any
 * further, so the caller reports the original rejection instead of looping
 * forever.
 */
export const splitPeeringFilter = (
  filter: SubscriptionFilter,
  nowSeconds: number,
): [SubscriptionFilter, SubscriptionFilter] | undefined => {
  const since = filter.since ?? 0
  const until = filter.until ?? nowSeconds
  if (until <= since) {
    return undefined
  }

  const midpoint = Math.floor((since + until) / 2)

  return [
    { ...filter, since, until: midpoint },
    { ...filter, since: midpoint + 1, until },
  ]
}
