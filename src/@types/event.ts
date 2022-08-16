import { EventKinds } from '../constants/base'
import { Pubkey, TagName } from './base'

export type EventId = string

export type Tag = TagBase | []

export interface TagBase {
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

export interface DBEvent {
  id: string
  event_id: Buffer
  event_pubkey: Buffer
  event_kind: number
  event_created_at: number
  event_content: string
  event_tags: Tag[]
  event_signature: Buffer
  first_seen: Date
}

export interface CanonicalEvent {
  0: 0
  1: string
  2: number
  3: number
  4: Tag[]
  5: string
}
