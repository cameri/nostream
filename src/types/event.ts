import { Pubkey } from 'types'

export type EventId = string

export interface Tag {
  [index: number]: string
}

export enum EventKinds {
  SET_METADATA = 0,
  TEXT_NODE = 1,
  RECOMMEND_SERVER = 2,
  CONTACT_LIST = 3,
  ENCRYPTED_DIRECT_MESSAGE = 4,
  DELETE = 5,
}

export interface Event {
  id: EventId
  pubkey: Pubkey
  created_at: number
  kind: EventKinds
  tags: Tag[]
  sig: string
  content: string
}

export interface CanonicalEvent {
  0: 0
  1: string
  2: number
  3: number
  4: Tag[]
  5: string
}
