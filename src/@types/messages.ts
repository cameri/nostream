import { ContextMetadata, EventId, Range, Secret } from './base'
import { Event, RelayedEvent } from './event'
import { SubscriptionFilter, SubscriptionId } from './subscription'
import { ContextMetadataKey } from '../constants/base'

export enum MessageType {
  REQ = 'REQ',
  EVENT = 'EVENT',
  CLOSE = 'CLOSE',
  NOTICE = 'NOTICE',
  EOSE = 'EOSE',
  OK = 'OK',
  COUNT = 'COUNT',
  CLOSED = 'CLOSED',
  AUTH = 'AUTH',
  NEG_OPEN = 'NEG-OPEN',
  NEG_MSG = 'NEG-MSG',
  NEG_CLOSE = 'NEG-CLOSE',
  NEG_ERR = 'NEG-ERR',
}

export type IncomingMessage = (
  | SubscribeMessage
  | IncomingEventMessage
  | UnsubscribeMessage
  | CountMessage
  | AuthMessage
  | NegOpenMessage
  | NegMsgMessage
  | NegCloseMessage
) & {
  [ContextMetadataKey]?: ContextMetadata
}

export type OutgoingMessage =
  | OutgoingEventMessage
  | EndOfStoredEventsNotice
  | NoticeMessage
  | CommandResult
  | CountResultMessage
  | ClosedMessage
  | AuthChallengeMessage
  | NegMsgMessage
  | NegErrMessage

export type SubscribeMessage = {
  [index in Range<2, 100>]: SubscriptionFilter
} & {
  0: MessageType.REQ
  1: SubscriptionId
} & Array<SubscriptionFilter>

export type CountMessage = {
  [index in Range<2, 100>]: SubscriptionFilter
} & {
  0: MessageType.COUNT
  1: SubscriptionId
} & Array<SubscriptionFilter>

export type IncomingEventMessage = EventMessage & [MessageType.EVENT, Event]

export type IncomingRelayedEventMessage = [MessageType.EVENT, RelayedEvent, Secret]

export interface EventMessage {
  0: MessageType.EVENT
  1: Event
  2?: Secret
}

export interface OutgoingEventMessage {
  0: MessageType.EVENT
  1: SubscriptionId
  2: Event
}

export interface UnsubscribeMessage {
  0: MessageType.CLOSE
  1: SubscriptionId
}

export interface NoticeMessage {
  0: MessageType.NOTICE
  1: string
}

export interface CommandResult {
  0: MessageType.OK
  1: EventId
  2: boolean
  3: string
  4?: string
}

export interface EndOfStoredEventsNotice {
  0: MessageType.EOSE
  1: SubscriptionId
}

export interface CountResultPayload {
  count: number
  approximate?: boolean
  hll?: string
}

export interface CountResultMessage {
  0: MessageType.COUNT
  1: SubscriptionId
  2: CountResultPayload
}

export interface ClosedMessage {
  0: MessageType.CLOSED
  1: SubscriptionId
  2: string
  3?: string
}

// NIP-42
export interface AuthMessage {
  0: MessageType.AUTH
  1: Event
}

export interface AuthChallengeMessage {
  0: MessageType.AUTH
  1: string
}

// NIP-77
export interface NegOpenMessage {
  0: MessageType.NEG_OPEN
  1: SubscriptionId
  2: SubscriptionFilter
  /** Hex-encoded initial negentropy message. */
  3: string
}

/** Sent in both directions; the payload is a hex-encoded negentropy message. */
export interface NegMsgMessage {
  0: MessageType.NEG_MSG
  1: SubscriptionId
  2: string
}

export interface NegCloseMessage {
  0: MessageType.NEG_CLOSE
  1: SubscriptionId
}

export interface NegErrMessage {
  0: MessageType.NEG_ERR
  1: SubscriptionId
  2: string
  /** For `blocked:` replies, the most records a session may hold. */
  3?: number
}
