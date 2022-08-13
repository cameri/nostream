import { IWebSocketAdapter } from '../../@types/adapters'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IEventRepository } from '../../@types/repositories'


export class DefaultEventStrategy implements IEventStrategy<Event, Promise<boolean>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute(event: Event): Promise<boolean> {
    try {
      const count = await this.eventRepository.create(event)
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
