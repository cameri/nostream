import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const debug = createLogger('ephemeral-event-strategy')

export class EphemeralEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  public async execute(event: Event): Promise<void> {
    debug('received ephemeral event: %o', event)
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createCommandResult(event.id, true, ''),
    )
    this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
  }
}
