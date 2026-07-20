import { EventKinds, EventTags } from '../constants/base'
import { EventKindsRange, Settings } from '../@types/settings'
import { Event } from '../@types/event'
import { isEventKindOrRangeMatch } from './event'
import { Pubkey } from '../@types/base'
import { SubscriptionFilter } from '../@types/subscription'

// NIP-42: restricted kinds are only readable by the author or a p-tagged recipient.

export const DEFAULT_RESTRICTED_READ_KINDS: (EventKinds | EventKindsRange)[] = [
  EventKinds.ENCRYPTED_DIRECT_MESSAGE,
  EventKinds.GIFT_WRAP,
]

export const getRestrictedReadKinds = (settings: Settings | undefined): (EventKinds | EventKindsRange)[] => {
  const restrictedReads = settings?.nip42?.restrictedReads
  if (!restrictedReads?.enabled) {
    return []
  }

  return Array.isArray(restrictedReads.kinds) ? restrictedReads.kinds : DEFAULT_RESTRICTED_READ_KINDS
}

const isKindRestricted = (restrictedKinds: (EventKinds | EventKindsRange)[], kind: number): boolean =>
  restrictedKinds.some(isEventKindOrRangeMatch({ kind } as Event))

export const isClientAuthorizedToReadEvent = (event: Event, authenticatedPubkeys: ReadonlySet<Pubkey>): boolean => {
  if (!authenticatedPubkeys.size) {
    return false
  }

  if (authenticatedPubkeys.has(event.pubkey)) {
    return true
  }

  return event.tags.some(
    (tag) => tag.length >= 2 && tag[0] === EventTags.Pubkey && authenticatedPubkeys.has(tag[1]),
  )
}

// getAuthenticatedPubkeys is only read for restricted events, so the guard is free when disabled.
export const createReadAuthorizationGuard = (
  settings: Settings | undefined,
  getAuthenticatedPubkeys: () => ReadonlySet<Pubkey>,
): ((event: Event) => boolean) => {
  const restrictedKinds = getRestrictedReadKinds(settings)
  if (!restrictedKinds.length) {
    return () => true
  }

  return (event: Event) => {
    if (!isKindRestricted(restrictedKinds, event.kind)) {
      return true
    }

    return isClientAuthorizedToReadEvent(event, getAuthenticatedPubkeys())
  }
}

const isFullyRestrictedFilter =
  (restrictedKinds: (EventKinds | EventKindsRange)[]) =>
  (filter: SubscriptionFilter): boolean =>
    Array.isArray(filter.kinds) &&
    filter.kinds.length > 0 &&
    filter.kinds.every((kind) => isKindRestricted(restrictedKinds, kind))

// A sub that only asks for restricted kinds can never return anything to an
// unauthenticated client, so we close it instead of serving an empty stream.
export const isSubscriptionAuthRequired = (
  settings: Settings | undefined,
  filters: SubscriptionFilter[],
  getAuthenticatedPubkeys: () => ReadonlySet<Pubkey>,
): boolean => {
  const restrictedKinds = getRestrictedReadKinds(settings)
  if (!restrictedKinds.length) {
    return false
  }

  if (!filters.length || !filters.every(isFullyRestrictedFilter(restrictedKinds))) {
    return false
  }

  return getAuthenticatedPubkeys().size === 0
}

// COUNT can't be filtered per event, so a restricted-kind filter must be
// scoped to the client's own pubkeys via authors/#p.
export const isCountAuthorized = (
  settings: Settings | undefined,
  filters: SubscriptionFilter[],
  getAuthenticatedPubkeys: () => ReadonlySet<Pubkey>,
): boolean => {
  const restrictedKinds = getRestrictedReadKinds(settings)
  if (!restrictedKinds.length) {
    return true
  }

  const restrictedFilters = filters.filter(
    (filter) => Array.isArray(filter.kinds) && filter.kinds.some((kind) => isKindRestricted(restrictedKinds, kind)),
  )
  if (!restrictedFilters.length) {
    return true
  }

  const authenticatedPubkeys = getAuthenticatedPubkeys()
  const isScopedToClient = (values?: Pubkey[]) =>
    Array.isArray(values) && values.length > 0 && values.every((value) => authenticatedPubkeys.has(value))

  return restrictedFilters.every(
    (filter) => isScopedToClient(filter.authors) || isScopedToClient(filter['#p']),
  )
}
