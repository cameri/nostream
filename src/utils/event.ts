import * as secp256k1 from '@noble/secp256k1'
import { CanonicalEvent, Event } from '../types/event'
import { SubscriptionFilter } from '../types/subscription'
import { isGenericTagQuery } from './filter'

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

      // NIP-01: Support #e and #p tags
      // NIP-12: Support generic tag queries

      if (
        Object.entries(filter)
          .filter(
            ([key, criteria]) =>
              isGenericTagQuery(key) && Array.isArray(criteria),
          )
          .some(([key, criteria]) => {
            return !event.tags.some(
              (tag) => tag[0] === key[1] && criteria.includes(tag[1]),
            )
          })
      ) {
        return false
      }

      return true
    }

export const isEventSignatureValid = async (event: Event): Promise<boolean> => {
  return secp256k1.schnorr.verify(event.sig, event.id, event.pubkey)
}
