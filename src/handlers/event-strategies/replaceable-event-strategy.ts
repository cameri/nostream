import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const debug = createLogger('replaceable-event-strategy')

export class ReplaceableEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<void> {
    debug('received replaceable event: %o', event)
    try {
      const count = await this.eventRepository.upsert(event)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, true, (count) ? '' : 'duplicate:'),
      )
      if (count) {
        this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.endsWith('duplicate key value violates unique constraint "events_event_id_unique"')) {
          this.webSocket.emit(
            WebSocketAdapterEvent.Message,
            createCommandResult(event.id, false, 'rejected: event already exists'),
          )
          return
        }

        this.webSocket.emit(
          WebSocketAdapterEvent.Message,
          createCommandResult(event.id, false, 'error: '),
        )
      }
    }
  }
}
