import { EventKinds } from '../constants/base'
import { Pubkey, TagName } from '../types/base'

export type EventId = string

export interface Tag {
  0: TagName
  [index: number]: string
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
