import * as secp256k1 from '@noble/secp256k1'
import { applySpec, converge, curry, mergeLeft, nth, omit, pipe, prop, reduceBy } from 'ramda'

import { CanonicalEvent, Event } from '../@types/event'
import { EventKinds, EventTags } from '../constants/base'
import { fromBuffer } from './transform'
import { isGenericTagQuery } from './filter'
import { RuneLike } from './runes/rune-like'
import { SubscriptionFilter } from '../@types/subscription'

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

  // NIP-01: Basic protocol flow description

  if (Array.isArray(filter.ids) && (
    !filter.ids.some(startsWith(event.id))
  )) {
    return false
  }

  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
    return false
  }

  if (typeof filter.since === 'number' && event.created_at < filter.since) {
    return false
  }

  if (typeof filter.until === 'number' && event.created_at > filter.until) {
    return false
  }

  if (Array.isArray(filter.authors)) {
    if (
      !filter.authors.some(startsWith(event.pubkey))
    ) {
      if (isDelegatedEvent(event)) {
        const delegation = event.tags.find((tag) => tag[0] === EventTags.Delegation)

        if (!filter.authors.some(startsWith(delegation[1]))) {
          return false
        }
      } else {
        return false
      }
    }
  }

  // NIP-27: Multicast
  // const targetMulticastGroups: string[] = event.tags.reduce(
  //   (acc, tag) => (tag[0] === EventTags.Multicast)
  //     ? [...acc, tag[1]]
  //     : acc,
  //   [] as string[]
  // )

  // if (targetMulticastGroups.length && !Array.isArray(filter['#m'])) {
  //   return false
  // }

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

export const isDelegatedEvent = (event: Event): boolean => {
  return event.tags.some((tag) => tag.length === 4 && tag[0] === EventTags.Delegation)
}

export const isDelegatedEventValid = async (event: Event): Promise<boolean> => {
  const delegation = event.tags.find((tag) => tag.length === 4 && tag[0] === EventTags.Delegation)
  if (!delegation) {
    return false
  }


  // Validate rune
  const runifiedEvent = (converge(
    curry(mergeLeft),
    [
      omit(['tags']),
      pipe(
        prop('tags') as any,
        reduceBy(
          (acc, tag) => ([...acc, tag[1]]),
          [],
          nth(0),
        ),
      ),
    ],
  ) as any)(event)

  let result: boolean
  try {
    [result] = RuneLike.from(delegation[2]).test(runifiedEvent)
  } catch (error) {
    result = false
  }

  if (!result) {
    return false
  }  

  const serializedDelegationTag = `nostr:${delegation[0]}:${event.pubkey}:${delegation[2]}`

  const token = await secp256k1.utils.sha256(Buffer.from(serializedDelegationTag))

  // Token generation to be decided:
  // const serializedDelegationTag = [
  //   delegation[0], // 'delegation'
  //   delegation[1], // <delegator>
  //   event.pubkey,  // <delegatee>
  //   delegation[2], // <rules>
  // ]
  // const token = await secp256k1.utils.sha256(Buffer.from(JSON.stringify(serializedDelegationTag)))

  // Validate delegation signature
  return secp256k1.schnorr.verify(delegation[3], token, delegation[1])
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

export const isDeleteEvent = (event: Event): boolean => {
  return event.kind === EventKinds.DELETE
}
