import {
  EndOfStoredEventsNotice,
  IncomingEventMessage,
  IncomingRelayedEventMessage,
  MessageType,
  NoticeMessage,
  OutgoingMessage,
  SubscribeMessage,
} from '../@types/messages'
import { Event, RelayedEvent } from '../@types/event'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { EventId } from '../@types/base'

export const createNoticeMessage = (notice: string): NoticeMessage => {
  return [MessageType.NOTICE, notice]
}

export const createOutgoingEventMessage = (
  subscriptionId: SubscriptionId,
  event: Event,
): OutgoingMessage => {
  return [MessageType.EVENT, subscriptionId, event]
}

// NIP-15
export const createEndOfStoredEventsNoticeMessage = (
  subscriptionId: SubscriptionId,
): EndOfStoredEventsNotice => {
  return [MessageType.EOSE, subscriptionId]
}

// NIP-20
export const createCommandResult = (eventId: EventId, successful: boolean, message: string) => {
  return [MessageType.OK, eventId, successful, message]
}

// NIP-42
export const createAuthEventMessage = (challenge) => {
  return [MessageType.AUTH, challenge]
}

export const createSubscriptionMessage = (
  subscriptionId: SubscriptionId,
  filters: SubscriptionFilter[]
): SubscribeMessage => {
  return [MessageType.REQ, subscriptionId, ...filters] as any
}

export const createRelayedEventMessage =
  (event: RelayedEvent, secret?: string): IncomingRelayedEventMessage | IncomingEventMessage => {
    if (!secret) {
      return [MessageType.EVENT, event]
    }

    return [MessageType.EVENT, event, secret]
  }
