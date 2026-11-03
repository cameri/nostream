import { EventKindsRange, PeeringScope } from '../@types/settings'
import { SubscriptionFilter } from '../@types/subscription'
import { EventKinds } from '../constants/base'

export const MAX_PEERING_KIND = 65535

/**
 * Overlap used when the live subscription starts after reconciliation. NIP-01
 * REQ has no "future only" mode, so ask for the last minute as well: an event
 * published while negentropy was running is then delivered either by the
 * reconciliation or by the live subscription, and duplicate inserts are
 * harmless. Periodic reconciliation closes any remaining gap.
 */
export const PEERING_LIVE_OVERLAP_SECONDS = 60

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

/**
 * The filter used to reconcile one advertised scope. A rolling window becomes
 * an absolute `since` at the moment of the reconciliation; `limit` is never
 * set because negentropy compares whole sets rather than pages.
 */
export const peeringScopeToFilter = (scope: PeeringScope, nowSeconds: number): SubscriptionFilter => {
  const filter: SubscriptionFilter = {
    kinds: scopeKinds(scope),
  }

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

const isCurrentScope = (scope: PeeringScope, nowSeconds: number): boolean =>
  typeof scope.until !== 'number' || scope.until >= nowSeconds

/**
 * Filters for the long-lived subscription. A scope whose `until` already passed
 * is historical only and gets no live subscription. Every current scope starts
 * from the recent overlap rather than dumping the whole scope again.
 */
export const peeringScopesToLiveFilters = (
  scopes: PeeringScope[],
  nowSeconds: number,
  overlapSeconds = PEERING_LIVE_OVERLAP_SECONDS,
): SubscriptionFilter[] =>
  scopes
    .filter((scope) => isCurrentScope(scope, nowSeconds))
    .map((scope) => {
      const filter = peeringScopeToFilter(scope, nowSeconds)
      const overlapSince = Math.max(0, nowSeconds - overlapSeconds)

      if (typeof scope.windowSeconds === 'number') {
        filter.since = overlapSince
        delete filter.until
      } else {
        filter.since = Math.max(filter.since ?? 0, overlapSince)
      }

      return filter
    })

export const isCurrentPeeringScope = (scope: PeeringScope, nowSeconds: number): boolean =>
  isCurrentScope(scope, nowSeconds)

const scopeBounds = (scope: PeeringScope, nowSeconds: number): { since: number; until: number } => {
  if (typeof scope.windowSeconds === 'number') {
    return { since: Math.max(0, nowSeconds - scope.windowSeconds), until: nowSeconds }
  }

  return {
    since: scope.since ?? 0,
    until: scope.until ?? nowSeconds,
  }
}

/**
 * Splits a scope at its midpoint in time when a peer rejects the whole set as
 * too large. Returns undefined when the range cannot be split any further, so
 * the caller reports the original rejection instead of looping forever.
 */
export const splitPeeringScope = (
  scope: PeeringScope,
  nowSeconds: number,
): [PeeringScope, PeeringScope] | undefined => {
  const { since, until } = scopeBounds(scope, nowSeconds)
  if (until <= since) {
    return undefined
  }

  const midpoint = Math.floor((since + until) / 2)

  return [
    { kinds: scope.kinds, since, until: midpoint },
    { kinds: scope.kinds, since: midpoint + 1, until },
  ]
}
