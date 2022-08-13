import { DefaultEventStrategy } from '../handlers/event-strategies/default-event-strategy'
import { EphemeralEventStrategy } from '../handlers/event-strategies/ephemeral-event-strategy'
import { NullEventStrategy } from '../handlers/event-strategies/null-event-strategy copy'
import { ReplaceableEventStrategy } from '../handlers/event-strategies/replaceable-event-strategy'
import { Factory } from '../@types/base'
import { Event } from '../@types/event'
import { IEventStrategy } from '../@types/message-handlers'
import { IEventRepository } from '../@types/repositories'
import { isEphemeralEvent, isNullEvent, isReplaceableEvent } from '../utils/event'
import { IWebSocketAdapter } from '../@types/adapters'


export const eventStrategyFactory = (
  eventRepository: IEventRepository,
): Factory<IEventStrategy<Event, Promise<boolean>>, [Event, IWebSocketAdapter]> => ([event, adapter]: [Event, IWebSocketAdapter]) => {
  if (isReplaceableEvent(event)) {
    return new ReplaceableEventStrategy(adapter, eventRepository)
  } else if (isEphemeralEvent(event)) {
    return new EphemeralEventStrategy(adapter)
  } else if (isNullEvent(event)) {
    return new NullEventStrategy()
  }

  return new DefaultEventStrategy(adapter, eventRepository)
}
