import { Event, ParameterizedReplaceableEvent } from '../../@types/event'
import { EventDeduplicationMetadataKey, EventTags } from '../../constants/base'
import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const debug = createLogger('parameterized-replaceable-event-strategy')

export class ParameterizedReplaceableEventStrategy
  implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<void> {
    debug('received parameterized replaceable event: %o', event)

    const [, ...deduplication] = event.tags.find((tag) => tag.length >= 2 && tag[0] === EventTags.Deduplication) ?? [null, '']

    const parameterizedReplaceableEvent: ParameterizedReplaceableEvent = {
      ...event,
      [EventDeduplicationMetadataKey]: deduplication,
    }

    const count = await this.eventRepository.upsert(parameterizedReplaceableEvent)
    this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, (count) ? '' : 'duplicate:'))

    if (count) {
      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
    }
  }
}
