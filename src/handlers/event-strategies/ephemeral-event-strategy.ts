import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { WebSocketAdapterEvent } from '../../constants/adapter'


export class EphemeralEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  public async execute(event: Event): Promise<void> {
    this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
  }
}
