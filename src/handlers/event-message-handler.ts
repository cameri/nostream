import { IMessageHandler, IEventStrategy } from '../@types/message-handlers'
import { IncomingEventMessage } from '../@types/messages'
import { WebSocket } from 'ws'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { isEventSignatureValid } from '../utils/event'

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    private readonly strategy: Factory<IEventStrategy<[Event, WebSocket], Promise<boolean>>, Event>
  ) { }

  public async handleMessage(message: IncomingEventMessage, client: WebSocket): Promise<void> {
    const [, event] = message
    if (!await isEventSignatureValid(event)) {
      console.warn(`Event ${event.id} from ${event.pubkey} with signature ${event.sig} is not valid`)
      return
    }

    const strategy = this.strategy(event)

    if (typeof strategy?.execute !== 'function') {
      return
    }

    try {
      await strategy.execute([event, client])
    } catch (error) {
      console.error('Error handling message:', message, error)
    }
  }
}
