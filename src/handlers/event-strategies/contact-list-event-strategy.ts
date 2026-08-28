import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { IWotGraphService } from '../../@types/services'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('contact-list-event-strategy')

export class ContactListEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly wotGraphService: IWotGraphService,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('received contact list event: %o', event)
    try {
      const count = await this.eventRepository.upsert(event)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createEventCommandResult(event.id, true, count ? '' : 'duplicate:'),
      )
      if (!count) {
        return
      }

      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)

      try {
        const follows = event.tags.filter((tag) => tag[0] === EventTags.Pubkey).map((tag) => tag[1])
        await this.wotGraphService.updateFollowList(event.pubkey, follows)
      } catch (error) {
        // WoT graph updates are best-effort: the contact list itself is
        // already stored and broadcast correctly, so a graph-update failure
        // here must not surface as a rejection of a valid event.
        logger.error('unable to update wot graph for pubkey %s: %o', event.pubkey, error)
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.endsWith('duplicate key value violates unique constraint "events_event_id_unique"')) {
          this.webSocket.emit(
            WebSocketAdapterEvent.Message,
            createEventCommandResult(event.id, false, 'rejected: event already exists'),
          )
          return
        }

        this.webSocket.emit(
          WebSocketAdapterEvent.Message,
          createEventCommandResult(event.id, false, `error: ${error.message}`),
        )
      }
    }
  }
}
