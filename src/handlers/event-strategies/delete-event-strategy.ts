import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { Tag } from '../../@types/base'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('delete-event-strategy')

export class DeleteEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('received delete event: %o', event)

    const isValidETag = (tag: Tag) => tag.length >= 2 && tag[0] === EventTags.Event && /^[0-9a-f]{64}$/.test(tag[1])

    // One pass over the tags. Building the list with `[...eventIds, tag[1]]` copies everything collected so far for
    // each tag, which is quadratic: an event with thousands of `e` tags blocked the worker for tens of milliseconds
    // before any of them was looked up. Repeated ids are asked for once.
    const eventIdsToDelete = new Set<string>()
    for (const tag of event.tags) {
      if (isValidETag(tag)) {
        eventIdsToDelete.add(tag[1])
      }
    }

    if (eventIdsToDelete.size) {
      await this.eventRepository.deleteByPubkeyAndIds(event.pubkey, [...eventIdsToDelete])
    }

    const count = await this.eventRepository.create(event)
    this.webSocket.emit(WebSocketAdapterEvent.Message, createEventCommandResult(event.id, true, count ? '' : 'duplicate:'))

    if (count) {
      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
    }
  }
}
