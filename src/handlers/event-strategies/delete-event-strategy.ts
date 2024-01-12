import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { Tag } from '../../@types/base'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const debug = createLogger('delete-event-strategy')

export class DeleteEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<void> {
    debug('received delete event: %o', event)

    const isValidETag = (tag: Tag) =>
      tag.length >= 2
      && tag[0] === EventTags.Event
      && /^[0-9a-f]{64}$/.test(tag[1])

    const eventIdsToDelete = event.tags.reduce(
      (eventIds, tag) => isValidETag(tag)
        ? [...eventIds, tag[1]]
        : eventIds,
      [] as string[]
    )

    if (eventIdsToDelete.length) {
      await this.eventRepository.deleteByPubkeyAndIds(
        event.pubkey,
        eventIdsToDelete
      )
    }

    const count = await this.eventRepository.create(event)
    this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, (count) ? '' : 'duplicate:'))

    if (count) {
      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
    }
  }
}
