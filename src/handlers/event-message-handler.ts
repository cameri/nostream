import { EventDelegatorMetadataKey, EventTags } from '../constants/base'
import { IEventStrategy, IMessageHandler } from '../@types/message-handlers'
import { isDelegatedEvent, isDelegatedEventValid, isEventIdValid, isEventSignatureValid } from '../utils/event'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { IncomingEventMessage } from '../@types/messages'
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

    if (isDelegatedEvent(event)) {
      if (await isDelegatedEventValid(event)) {
        const [, delegator] = event.tags.find((tag) => tag.length === 4 && tag[0] === EventTags.Delegation)
        event[EventDelegatorMetadataKey] = delegator
      } else {
        console.warn(`Delegated event ${event.id} from ${event.pubkey} is not valid`)
        return
      }
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
