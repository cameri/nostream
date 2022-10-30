import { mergeDeepLeft } from 'ramda'

import { DelegatedEvent, Event } from '../@types/event'
import { EventDelegatorMetadataKey, EventTags } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { createNoticeMessage } from '../utils/messages'
import { EventMessageHandler } from './event-message-handler'
import { IMessageHandler } from '../@types/message-handlers'
import { IncomingEventMessage } from '../@types/messages'
import { isDelegatedEventValid } from '../utils/event'
import { WebSocketAdapterEvent } from '../constants/adapter'

const debug = createLogger('delegated-event-message-handler')

export class DelegatedEventMessageHandler extends EventMessageHandler implements IMessageHandler {
  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    const [, event] = message

    let reason = this.canAcceptEvent(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createNoticeMessage(`Event rejected: ${reason}`))
      return
    }

    reason = await this.isEventValid(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createNoticeMessage(`Event rejected: ${reason}`))
      return
    }

    const [, delegator] = event.tags.find((tag) => tag.length === 4 && tag[0] === EventTags.Delegation)
    const delegatedEvent: DelegatedEvent = mergeDeepLeft(
      event,
      {
        [EventDelegatorMetadataKey]: delegator,
      }
    )

    const strategy = this.strategyFactory([delegatedEvent, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      return
    }

    try {
      await strategy.execute(delegatedEvent)
    } catch (error) {
      debug('error handling message %o: %o', message, error)
    }
  }

  protected async isEventValid(event: Event): Promise<string | undefined> {
    const reason = await super.isEventValid(event)
    if (reason) {
      return reason
    }
    if (!await isDelegatedEventValid(event)) {
      return `Event with id ${event.id} from ${event.pubkey} is invalid delegated event`
    }
  }
}
