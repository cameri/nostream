import { Event, CanonicalEvent } from 'types/event'
import { SubscriptionFilter } from 'types/subscription'

export const serializeEvent = (event: Partial<Event>): CanonicalEvent => [
  0,
  event.pubkey,
  event.created_at,
  event.kind,
  event.tags,
  event.content,
]

export const isEventMatchingFilter =
  (filter: SubscriptionFilter) =>
  (event: Event): boolean => {
    if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) {
      return false
    }

    if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
      return false
    }

    if (
      Array.isArray(filter.authors) &&
      !filter.authors.includes(event.pubkey)
    ) {
      return false
    }

    if (typeof filter.since === 'number' && event.created_at < filter.since) {
      return false
    }

    if (typeof filter.until === 'number' && event.created_at > filter.until) {
      return false
    }

    // TODO: support #e and #p tags
    // if (Array.isArray(filter['#e']) && filter['#e'].length) {
    //   filter['#e'].event.tags.some()
    // }
    return true
  }
