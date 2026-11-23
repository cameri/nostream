import type { IWebSocketAdapter } from '../../@types/adapters'
import type { Event } from '../../@types/event'
import type { IEventStrategy } from '../../@types/message-handlers'
import { WebSocketAdapterEvent } from '../../constants/adapter'
import { createEventCommandResult } from '../../telemetry/event-metrics'

/**
 * Acceptances are issued by the relay itself. A client-published kind 28938
 * would otherwise fall through to the ephemeral broadcast path.
 */
export class PeeringAcceptanceEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(private readonly webSocket: IWebSocketAdapter) {}

  public async execute(event: Event): Promise<void> {
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createEventCommandResult(event.id, false, 'invalid: kind 28938 is issued by the relay'),
    )
  }
}
