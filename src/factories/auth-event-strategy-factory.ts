import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { IEventStrategy } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import { SignedAuthEventStrategy } from '../handlers/event-strategies/auth-event-strategy'

export const signedAuthEventStrategyFactory = (
): Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]> =>
  ([, adapter]: [Event, IWebSocketAdapter]) => {
    return new SignedAuthEventStrategy(adapter)
  }
