export enum EventKinds {
  SET_METADATA = 0,
  TEXT_NOTE = 1,
  RECOMMEND_SERVER = 2,
  CONTACT_LIST = 3,
  ENCRYPTED_DIRECT_MESSAGE = 4,
  DELETE = 5,
  REACTION = 7,
  // Channels
  CHANNEL_CREATION = 40,
  CHANNEL_METADATA = 41,
  CHANNEL_MESSAGE = 42,
  CHANNEL_HIDE_MESSAGE = 43,
  CHANNEL_MUTE_USER = 44,
  CHANNEL_RESERVED_FIRST = 45,
  CHANNEL_RESERVED_LAST = 49,
  // Relay-only
  RELAY_INVITE = 50,
  INVOICE_UPDATE = 402,
  // Replaceable events
  REPLACEABLE_FIRST = 10000,
  REPLACEABLE_LAST = 19999,
  // Ephemeral events
  EPHEMERAL_FIRST = 20000,
  AUTH =  22242,
  EPHEMERAL_LAST = 29999,
  // Parameterized replaceable events
  PARAMETERIZED_REPLACEABLE_FIRST = 30000,
  PARAMETERIZED_REPLACEABLE_LAST = 39999,
  USER_APPLICATION_FIRST = 40000,
  USER_APPLICATION_LAST = Number.MAX_SAFE_INTEGER,
}

export enum EventTags {
  Event = 'e',
  Pubkey = 'p',
  //  Multicast = 'm',
  Delegation = 'delegation',
  Deduplication = 'd',
  Expiration = 'expiration',
  Relay = 'relay',
  Challenge = 'challenge'
}

export enum PaymentsProcessors {
  ZEBEDEE = 'zebedee',
}

export const EventDelegatorMetadataKey = Symbol('Delegator')
export const EventDeduplicationMetadataKey = Symbol('Deduplication')
export const ContextMetadataKey = Symbol('Context')
export const EventExpirationTimeMetadataKey = Symbol('Expiration')
