import {
  EndOfStoredEventsNotice,
  MessageType,
  Notice,
  OutgoingMessage,
} from '../@types/messages'
import { Event } from '../@types/event'
import { SubscriptionId } from '../@types/subscription'

export const createNotice = (notice: string): Notice => {
  return [MessageType.NOTICE, notice]
}

export const createOutgoingEventMessage = (
  subscriptionId: SubscriptionId,
  event: Event,
): OutgoingMessage => {
  return [MessageType.EVENT, subscriptionId, event]
}

export const createEndOfStoredEventsNoticeMessage = (
  subscriptionId: SubscriptionId,
): EndOfStoredEventsNotice => {
  return [MessageType.EOSE, subscriptionId]
}
