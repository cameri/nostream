import * as secp256k1 from '@noble/secp256k1'
import { applySpec, pipe, prop } from 'ramda'

import { CanonicalEvent, Event } from '../@types/event'
import { SubscriptionFilter } from '../@types/subscription'
import { isGenericTagQuery } from './filter'
import { fromBuffer } from './stream'

export const serializeEvent = (event: Partial<Event>): CanonicalEvent => [
  0,
  event.pubkey,
  event.created_at,
  event.kind,
  event.tags,
  event.content,
]

export const toNostrEvent = applySpec({
  id: pipe(prop('event_id'), fromBuffer),
  kind: prop('event_kind'),
  pubkey: pipe(prop('event_pubkey'), fromBuffer),
  created_at: prop('event_created_at'),
  content: prop('event_content'),
  tags: prop('event_tags'),
  sig: pipe(prop('event_signature'), fromBuffer),
})

export const isEventMatchingFilter = (filter: SubscriptionFilter) => (event: Event): boolean => {
  const startsWith = (input: string) => (prefix) => input.startsWith(prefix)

  if (Array.isArray(filter.ids) && (
    !filter.ids.some(startsWith(event.id))
  )) {
    return false
  }

  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
    return false
  }

  if (
    Array.isArray(filter.authors) &&
    !filter.authors.some(startsWith(event.pubkey))
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

export const isEventIdValid = async (event: Event): Promise<boolean> => {
  const id = await secp256k1.utils.sha256(Buffer.from(JSON.stringify(serializeEvent(event))))

  return Buffer.from(id).toString('hex') === event.id
}

export const isEventSignatureValid = async (event: Event): Promise<boolean> => {
  return secp256k1.schnorr.verify(event.sig, event.id, event.pubkey)
}

export const isReplaceableEvent = (event: Event): boolean => {
  return event.kind >= 10000 && event.kind < 20000
}

export const isEphemeralEvent = (event: Event): boolean => {
  return event.kind >= 20000 && event.kind < 30000
}

export const isNullEvent = (event: Event): boolean => {
  return event.kind === Number.MAX_SAFE_INTEGER
}
