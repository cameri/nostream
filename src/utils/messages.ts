import {
  EndOfStoredEventsNotice,
  MessageType,
  NoticeMessage,
  OutgoingMessage,
} from '../@types/messages'
import { Event } from '../@types/event'
import { EventId } from '../@types/base'
import { SubscriptionId } from '../@types/subscription'

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
