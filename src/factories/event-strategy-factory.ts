import { isDeleteEvent, isEphemeralEvent, isParameterizedReplaceableEvent, isReplaceableEvent, isRequestToVanishEvent } from '../utils/event'
import { DefaultEventStrategy } from '../handlers/event-strategies/default-event-strategy'
import { DeleteEventStrategy } from '../handlers/event-strategies/delete-event-strategy'
import { EphemeralEventStrategy } from '../handlers/event-strategies/ephemeral-event-strategy'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { IEventRepository } from '../@types/repositories'
import { IEventStrategy } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import { ParameterizedReplaceableEventStrategy } from '../handlers/event-strategies/parameterized-replaceable-event-strategy'
import { ReplaceableEventStrategy } from '../handlers/event-strategies/replaceable-event-strategy'
import { VanishEventStrategy } from '../handlers/event-strategies/vanish-event-strategy'

export const eventStrategyFactory = (
  eventRepository: IEventRepository,
): Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]> =>
  ([event, adapter]: [Event, IWebSocketAdapter]) => {
    if (isRequestToVanishEvent(event)) {
      return new VanishEventStrategy(adapter, eventRepository)
    } else if (isReplaceableEvent(event)) {
      return new ReplaceableEventStrategy(adapter, eventRepository)
    } else if (isEphemeralEvent(event)) {
      return new EphemeralEventStrategy(adapter)
    } else if (isDeleteEvent(event)) {
      return new DeleteEventStrategy(adapter, eventRepository)
    } else if (isParameterizedReplaceableEvent(event)) {
      return new ParameterizedReplaceableEventStrategy(adapter, eventRepository)
    } 

    return new DefaultEventStrategy(adapter, eventRepository)
  }
