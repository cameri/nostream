import { WebSocket } from 'ws'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketServerAdapter } from '../../@types/servers'


export class EphemeralEventStrategy implements IEventStrategy<[Event, WebSocket], Promise<boolean>> {
  public constructor(
    private readonly adapter: IWebSocketServerAdapter,
  ) { }

  public async execute([event,]: [Event, WebSocket]): Promise<boolean> {
    console.log('Ephemeral event')
    try {
      await this.adapter.broadcastEvent(event)
    } catch (error) {
      console.error('Unable to handle event. Reason:', error)

      return false
    }
  }
}
