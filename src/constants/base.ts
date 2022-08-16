export enum EventKinds {
  SET_METADATA = 0,
  TEXT_NODE = 1,
  RECOMMEND_SERVER = 2,
  CONTACT_LIST = 3,
  ENCRYPTED_DIRECT_MESSAGE = 4,
  DELETE = 5,
  REACTION = 7,
}

export enum EventTags {
  Event = 'e',
  Pubkey = 'p',
}
