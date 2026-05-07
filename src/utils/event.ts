import * as secp256k1 from '@noble/secp256k1'
import { ALL_RELAYS, EventKinds, EventTags } from '../constants/base'
import { applySpec, pipe, prop } from 'ramda'
import { CanonicalEvent, DBEvent, Event, UnidentifiedEvent, UnsignedEvent } from '../@types/event'
import { EventId, Pubkey, Tag } from '../@types/base'
import cluster from 'cluster'
import { deriveFromSecret } from './secret'
import { EventKindsRange } from '../@types/settings'
import { fromBuffer } from './transform'
import { getLeadingZeroBits } from './proof-of-work'
import { isGenericTagQuery, isGeohashPrefixCriterion, stripGeohashPrefixWildcard } from './filter'
import { SubscriptionFilter } from '../@types/subscription'
import { WebSocketServerAdapterEvent } from '../constants/adapter'

export const serializeEvent = (event: UnidentifiedEvent): CanonicalEvent => [
  0,
  event.pubkey,
  event.created_at,
  event.kind,
  event.tags,
  event.content,
]

export const toNostrEvent: (event: DBEvent) => Event = applySpec({
  id: pipe(prop('event_id') as () => Buffer, fromBuffer),
  kind: prop('event_kind') as () => number,
  pubkey: pipe(prop('event_pubkey') as () => Buffer, fromBuffer),
  created_at: prop('event_created_at') as () => number,
  content: prop('event_content') as () => string,
  tags: prop('event_tags') as () => Tag[],
  sig: pipe(prop('event_signature') as () => Buffer, fromBuffer),
})

export const isEventKindOrRangeMatch =
  ({ kind }: Event) =>
  (item: EventKinds | EventKindsRange) =>
    typeof item === 'number' ? item === kind : kind >= item[0] && kind <= item[1]

export const isEventMatchingFilter =
  (filter: SubscriptionFilter) =>
  (event: Event): boolean => {
    const startsWith = (input: string) => (prefix: string) => input.startsWith(prefix)
    const isMatchingGenericTagCriterion = (key: string, criterion: string) => (tag: Tag): boolean => {
      const [, tagName] = key
      if (tag[0] !== tagName) {
        return false
      }

      if (isGeohashPrefixCriterion(key, criterion)) {
        return tag[1].startsWith(stripGeohashPrefixWildcard(criterion))
      }

      return tag[1] === criterion
    }

    // NIP-01: Basic protocol flow description

    if (Array.isArray(filter.ids) && !filter.ids.some(startsWith(event.id))) {
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
      if (!filter.authors.some(startsWith(event.pubkey))) {
        return false
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
        .filter(([key, criteria]) => isGenericTagQuery(key) && Array.isArray(criteria))
        .some(([key, criteria]) => {
          return !event.tags.some((tag) => criteria.some((criterion) => isMatchingGenericTagCriterion(key, criterion)(tag)))
        })
    ) {
      return false
    }

    return true
  }

export const getEventHash = async (event: Event | UnidentifiedEvent | UnsignedEvent): Promise<string> => {
  const id = await secp256k1.utils.sha256(Buffer.from(JSON.stringify(serializeEvent(event))))

  return Buffer.from(id).toString('hex')
}

export const isEventIdValid = async (event: Event): Promise<boolean> => {
  return event.id === (await getEventHash(event))
}

export const isEventSignatureValid = async (event: Event): Promise<boolean> => {
  return secp256k1.schnorr.verify(event.sig, event.id, event.pubkey)
}

export const identifyEvent = async (event: UnidentifiedEvent): Promise<UnsignedEvent> => {
  const id = await getEventHash(event)

  return { ...event, id }
}

let privateKeyCache: string | undefined
export function getRelayPrivateKey(secret?: string): string {
  if (privateKeyCache) {
    return privateKeyCache
  }

  if (process.env.RELAY_PRIVATE_KEY) {
    privateKeyCache = process.env.RELAY_PRIVATE_KEY

    return privateKeyCache
  }

  privateKeyCache = deriveFromSecret(secret).toString('hex')

  return privateKeyCache
}

const publicKeyCache: Record<string, string> = {}
export const getPublicKey = (privkey: string) => {
  if (privkey in publicKeyCache) {
    return publicKeyCache[privkey]
  }

  publicKeyCache[privkey] = secp256k1.utils.bytesToHex(secp256k1.getPublicKey(privkey, true).subarray(1))

  return publicKeyCache[privkey]
}

export const signEvent =
  (privkey: string | Buffer | undefined) =>
  async (event: UnsignedEvent): Promise<Event> => {
    const sig = await secp256k1.schnorr.sign(event.id, privkey as any)
    return { ...event, sig: Buffer.from(sig).toString('hex') }
  }

export const broadcastEvent = async (event: Event): Promise<Event> => {
  return new Promise((resolve, reject) => {
    if (!cluster.isWorker || typeof process.send === 'undefined') {
      return resolve(event)
    }

    process.send(
      {
        eventName: WebSocketServerAdapterEvent.Broadcast,
        event,
      },
      undefined,
      undefined,
      (error: Error | null) => {
        if (error) {
          return reject(error)
        }
        resolve(event)
      },
    )
  })
}

export const isReplaceableEvent = (event: Event): boolean => {
  return (
    event.kind === EventKinds.SET_METADATA ||
    event.kind === EventKinds.CONTACT_LIST ||
    event.kind === EventKinds.CHANNEL_METADATA ||
    (event.kind >= EventKinds.REPLACEABLE_FIRST && event.kind <= EventKinds.REPLACEABLE_LAST)
  )
}

export const isEphemeralEvent = (event: Event): boolean => {
  return event.kind >= EventKinds.EPHEMERAL_FIRST && event.kind <= EventKinds.EPHEMERAL_LAST
}

export const isParameterizedReplaceableEvent = (event: Event): boolean => {
  return (
    event.kind >= EventKinds.PARAMETERIZED_REPLACEABLE_FIRST && event.kind <= EventKinds.PARAMETERIZED_REPLACEABLE_LAST
  )
}

export const isDeleteEvent = (event: Event): boolean => {
  return event.kind === EventKinds.DELETE
}

export const isRequestToVanishEvent = (event: Event, relayUrl?: string): boolean => {
  if (event.kind !== EventKinds.REQUEST_TO_VANISH) {
    return false
  }

  if (typeof relayUrl === 'undefined') {
    return true
  }

  const relayTags = event.tags.filter((tag) => tag.length >= 2 && tag[0] === EventTags.Relay).map((tag) => tag[1])

  return relayTags.length > 0 && relayTags.every((relay) => relay === relayUrl || relay === ALL_RELAYS)
}

export const isExpiredEvent = (event: Event): boolean => {
  if (!event.tags.length) {
    return false
  }

  const expirationTime = getEventExpiration(event)

  if (!expirationTime) {
    return false
  }

  const now = Math.floor(new Date().getTime() / 1000)

  return expirationTime <= now
}

export const getEventExpiration = (event: Event): number | undefined => {
  const [, rawExpirationTime] = event.tags.find((tag) => tag.length >= 2 && tag[0] === EventTags.Expiration) ?? []
  if (!rawExpirationTime) {
    return
  }

  const expirationTime = Number(rawExpirationTime)

  if (Number.isSafeInteger(expirationTime) && Math.log10(expirationTime) < 10) {
    return expirationTime
  }
}

export const getEventProofOfWork = (eventId: EventId): number => {
  return getLeadingZeroBits(Buffer.from(eventId, 'hex'))
}

export const getPubkeyProofOfWork = (pubkey: Pubkey): number => {
  return getLeadingZeroBits(Buffer.from(pubkey, 'hex'))
}

// NIP-17: Private Direct Messages helpers

export const isGiftWrapEvent = (event: Event): boolean => {
  return event.kind === EventKinds.GIFT_WRAP
}

export const isSealEvent = (event: Event): boolean => {
  return event.kind === EventKinds.SEAL
}

export const isDirectMessageEvent = (event: Event): boolean => {
  return event.kind === EventKinds.DIRECT_MESSAGE
}

export const isFileMessageEvent = (event: Event): boolean => {
  return event.kind === EventKinds.FILE_MESSAGE
}

// NIP-03: OpenTimestamps attestation
export const isOpenTimestampsEvent = (event: Event): boolean => {
  return event.kind === EventKinds.OPEN_TIMESTAMPS
}

// Marmot Protocol helpers

export const isWelcomeRumorEvent = (event: Event): boolean => {
  return event.kind === EventKinds.MARMOT_WELCOME_RUMOR
}

export const isMarmotGroupEvent = (event: Event): boolean => {
  return event.kind === EventKinds.MARMOT_GROUP_EVENT
}
