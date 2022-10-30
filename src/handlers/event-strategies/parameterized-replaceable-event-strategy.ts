import { Event, ParameterizedReplaceableEvent } from '../../@types/event'
import { EventDeduplicationMetadataKey, EventTags } from '../../constants/base'
import { createLogger } from '../../factories/logger-factory'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const debug = createLogger('parameterized-replaceable-event-strategy')

export class ParameterizedReplaceableEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<void> {
    debug('received event: %o', event)

    const [, ...deduplication] = event.tags.find((tag) => tag.length >= 2 && tag[0] === EventTags.Deduplication) ?? [null, '']

    const parameterizedReplaceableEvent: ParameterizedReplaceableEvent = {
      ...event,
      [EventDeduplicationMetadataKey]: deduplication,
    }

    const count = await this.eventRepository.upsert(parameterizedReplaceableEvent)
    if (!count) {
      return
    }

    this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
  }
}
