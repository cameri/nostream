import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IEventRepository } from '../../@types/repositories'
import { IWebSocketAdapter } from '../../@types/adapters'


export class ReplaceableEventStrategy implements IEventStrategy<Event, Promise<boolean>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<boolean> {
    try {
      const count = await this.eventRepository.upsert(event)
      if (!count) {
        return true
      }

      await this.webSocket.getWebSocketServer().broadcastEvent(event)

      return true
    } catch (error) {
      console.error('Unable to handle event. Reason:', error)

      return false
    }
  }
}
