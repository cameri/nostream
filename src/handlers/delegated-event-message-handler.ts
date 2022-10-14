import { EventDelegatorMetadataKey, EventTags } from '../constants/base'
import { createNoticeMessage } from '../utils/messages'
import { Event } from '../@types/event'
import { EventMessageHandler } from './event-message-handler'
import { IMessageHandler } from '../@types/message-handlers'
import { IncomingEventMessage } from '../@types/messages'
import { isDelegatedEventValid } from '../utils/event'
import { WebSocketAdapterEvent } from '../constants/adapter'

export class DelegatedEventMessageHandler extends EventMessageHandler implements IMessageHandler {
  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    const [, event] = message

    let reason = this.canAcceptEvent(event)
    if (reason) {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createNoticeMessage(`Event rejected: ${reason}`))
      console.warn(`Event ${event.id} rejected. Reason: ${reason}`)
      return
    }

    reason = await this.isEventValid(event)
    if (reason) {
      console.warn(`Event ${event.id} rejected. Reason: ${reason}`)
      return
    }

    const [, delegator] = event.tags.find((tag) => tag.length === 4 && tag[0] === EventTags.Delegation)
    event[EventDelegatorMetadataKey] = delegator

    const strategy = this.strategyFactory([event, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      return
    }

    try {
      await strategy.execute(event)
    } catch (error) {
      console.error('Error handling message:', message, error)
    }
  }

  protected async isEventValid(event: Event): Promise<string | undefined> {
    const reason = super.isEventValid(event)
    if (reason) {
      return reason
    }
    if (!await isDelegatedEventValid(event)) {
      return `Event with id ${event.id} from ${event.pubkey} is invalid delegated event`
    }
  }
}
