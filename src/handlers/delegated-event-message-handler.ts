import { EventDelegatorMetadataKey, EventTags } from '../constants/base'
import { createCommandResult } from '../utils/messages'
import { createLogger } from '../factories/logger-factory'
import { DelegatedEvent } from '../@types/event'
import { EventMessageHandler } from './event-message-handler'
import { IMessageHandler } from '../@types/message-handlers'
import { IncomingEventMessage } from '../@types/messages'
import { isDelegatedEventValid } from '../utils/event'
import { WebSocketAdapterEvent } from '../constants/adapter'

const debug = createLogger('delegated-event-message-handler')

export class DelegatedEventMessageHandler extends EventMessageHandler implements IMessageHandler {
  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    const [, event] = message

    let reason = await this.isEventValid(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    if (await this.isRateLimited(event)) {
      debug('event %s rejected: rate-limited')
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'rate-limited: slow down'))
      return
    }

    reason = this.canAcceptEvent(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    reason = await this.isUserAdmitted(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    const [, delegator] = event.tags.find((tag) => tag.length === 4 && tag[0] === EventTags.Delegation)
    const delegatedEvent: DelegatedEvent = {
      ...event,
        [EventDelegatorMetadataKey]: delegator,
    }

    const strategy = this.strategyFactory([delegatedEvent, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'error: event not supported'))
      return
    }

    try {
      await strategy.execute(delegatedEvent)
    } catch (error) {
      console.error('error handling message', message, error)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'error: unable to process event'))
    }
  }

  protected async isEventValid(event: DelegatedEvent): Promise<string | undefined> {
    const reason = await super.isEventValid(event)
    if (reason) {
      return reason
    }

    if (!await isDelegatedEventValid(event)) {
      return 'invalid: delegation verification failed'
    }
  }
}
