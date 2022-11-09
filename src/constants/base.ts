export enum EventKinds {
  SET_METADATA = 0,
  TEXT_NODE = 1,
  RECOMMEND_SERVER = 2,
  CONTACT_LIST = 3,
  ENCRYPTED_DIRECT_MESSAGE = 4,
  DELETE = 5,
  REACTION = 7,
  REPLACEABLE_FIRST = 10000,
  REPLACEABLE_LAST = 19999,
  EPHEMERAL_FIRST = 20000,
  EPHEMERAL_LAST = 29999,
}

export enum EventTags {
  Event = 'e',
  Pubkey = 'p',
  //  Multicast = 'm',
  Delegation = 'delegation',
  Deduplication = 'd',
}

export const EventDelegatorMetadataKey = Symbol('Delegator')
export const EventDeduplicationMetadataKey = Symbol('Deduplication')
