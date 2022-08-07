import { Event } from './types/event'
import { SubscriptionId } from './types/subscription'
import { MessageType, Notice, OutgoingEventMessage } from './types/messages'

export const createNotice = (notice: string): Notice => {
  return [MessageType.NOTICE, notice]
}

export const createOutgoingEventMessage = (
  subscriptionId: SubscriptionId,
  event: Event,
): OutgoingEventMessage => {
  return [MessageType.EVENT, subscriptionId, event]
}
