export enum EventKinds {
  SET_METADATA = 0,
  TEXT_NOTE = 1,
  RECOMMEND_SERVER = 2,
  CONTACT_LIST = 3,
  ENCRYPTED_DIRECT_MESSAGE = 4,
  DELETE = 5,
  REPOST = 6,
  REACTION = 7,
  // NIP-17: Private Direct Messages
  SEAL = 13,
  DIRECT_MESSAGE = 14,
  FILE_MESSAGE = 15,
  REQUEST_TO_VANISH = 62,
  // Channels
  CHANNEL_CREATION = 40,
  CHANNEL_METADATA = 41,
  CHANNEL_MESSAGE = 42,
  CHANNEL_HIDE_MESSAGE = 43,
  CHANNEL_MUTE_USER = 44,
  CHANNEL_RESERVED_FIRST = 45,
  CHANNEL_RESERVED_LAST = 49,
  // NIP-17: Gift Wrap
  GIFT_WRAP = 1059,
  // NIP-03: OpenTimestamps attestation
  OPEN_TIMESTAMPS = 1040,
  // Relay-only
  RELAY_INVITE = 50,
  INVOICE_UPDATE = 402,
  // Lightning zaps
  ZAP_REQUEST = 9734,
  ZAP_RECEIPT = 9735,
  // Replaceable events
  REPLACEABLE_FIRST = 10000,
  // NIP-65: Relay List Metadata
  RELAY_LIST = 10002,
  REPLACEABLE_LAST = 19999,
  // Ephemeral events
  EPHEMERAL_FIRST = 20000,
  EPHEMERAL_LAST = 29999,
  // Parameterized replaceable events
  PARAMETERIZED_REPLACEABLE_FIRST = 30000,
  PARAMETERIZED_REPLACEABLE_LAST = 39999,
  USER_APPLICATION_FIRST = 40000,
}

export enum EventTags {
  Event = 'e',
  Pubkey = 'p',
  Relay = 'r',
  // NIP-14: Subject for text notes
  Subject = 'subject',
  //  Multicast = 'm',
  Deduplication = 'd',
  Expiration = 'expiration',
  Invoice = 'bolt11',
  // NIP-03: target event kind on an OpenTimestamps attestation
  Kind = 'k',
  // NIP-12: geohash tag for location-based queries
  Geohash = 'g',
}

export const ALL_RELAYS = 'ALL_RELAYS'
export const DEFAULT_FILTER_LIMIT = 500

export enum PaymentsProcessors {
  LNURL = 'lnurl',
  ZEBEDEE = 'zebedee',
  LNBITS = 'lnbits',
}

export const EventDeduplicationMetadataKey = Symbol('Deduplication')
export const ContextMetadataKey = Symbol('Context')
export const EventExpirationTimeMetadataKey = Symbol('Expiration')
