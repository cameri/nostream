import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'


export class EphemeralEventStrategy implements IEventStrategy<Event, Promise<boolean>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  public async execute(event: Event): Promise<boolean> {
    try {
      await this.webSocket.getWebSocketServer().broadcastEvent(event)
    } catch (error) {
      console.error('Unable to handle event. Reason:', error)

      return false
    }
  }
}
