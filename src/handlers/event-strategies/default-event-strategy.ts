import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event, ExpiredEvent } from '../../@types/event'
import { EventExpirationMetadataKey, EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const debug = createLogger('default-event-strategy')

export class DefaultEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  protected async isEventExpired(event: Event): Promise<Event | ExpiredEvent> {
    const [, rawExpirationTime] = event.tags.find((tag) => tag.length === 2 && tag[0] === EventTags.Expiration)
    
    const currentTime = Date.now()
    const expirationTime = Number(rawExpirationTime)
    const isExpired = currentTime >= expirationTime

    if (isExpired) {
      const expiredEvent: ExpiredEvent = {
        ...event,
          [EventExpirationMetadataKey]: expirationTime,
      }
      return expiredEvent
    } 

    return event
  }

  public async execute(event: Event): Promise<void> {
    debug('received event: %o', event)
    const count = await this.eventRepository.create(event)
    this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, (count) ? '' : 'duplicate:'))

    if (count) {
      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
    }
  }
}
