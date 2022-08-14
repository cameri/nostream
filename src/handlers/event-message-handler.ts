import { IMessageHandler, IEventStrategy } from '../@types/message-handlers'
import { IncomingEventMessage } from '../@types/messages'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { isEventIdValid, isEventSignatureValid } from '../utils/event'
import { IWebSocketAdapter } from '../@types/adapters'

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly strategyFactory: Factory<IEventStrategy<Event, Promise<boolean>>, [Event, IWebSocketAdapter]>
  ) { }

  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    const [, event] = message
    console.log('Received event:', event)
    if (!await isEventSignatureValid(event) || !isEventIdValid(event)) {
      console.warn(`Event ${event.id} from ${event.pubkey} with signature ${event.sig} is not valid`)
      return
    }

    const strategy = this.strategyFactory([event, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      return
    }

    try {
      await strategy.execute(event)
    } catch (error) {
      console.error('Error handling message:', message, error)
    }
  }
}
