import { WebSocket } from 'ws'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IEventRepository } from '../../@types/repositories'
import { IWebSocketServerAdapter } from '../../@types/servers'


export class ReplaceableEventStrategy implements IEventStrategy<[Event, WebSocket], Promise<boolean>> {
  public constructor(
    private readonly adapter: IWebSocketServerAdapter,
    private readonly eventRepository: IEventRepository,
  ) { }

  public async execute([event,]: [Event, WebSocket]): Promise<boolean> {
    console.log('Replaceable event')
    try {
      const count = await this.eventRepository.upsert(event)
      if (!count) {
        return true
      }

      await this.adapter.broadcastEvent(event)

      return true
    } catch (error) {
      console.error('Unable to handle event. Reason:', error)

      return false
    }
  }
}
