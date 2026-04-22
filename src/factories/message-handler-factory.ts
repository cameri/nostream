import { ICacheAdapter, IWebSocketAdapter } from '../@types/adapters'
import { IEventRepository, INip05VerificationRepository, IUserRepository } from '../@types/repositories'
import { IncomingMessage, MessageType } from '../@types/messages'
import { createSettings } from './settings-factory'
import { CountMessageHandler } from '../handlers/count-message-handler'
import { EventMessageHandler } from '../handlers/event-message-handler'
import { eventStrategyFactory } from './event-strategy-factory'
import { getCacheClient } from '../cache/client'
import { RedisAdapter } from '../adapters/redis-adapter'
import { rateLimiterFactory } from './rate-limiter-factory'
import { SubscribeMessageHandler } from '../handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from '../handlers/unsubscribe-message-handler'

let cacheAdapter: ICacheAdapter | undefined = undefined
const getCache = (): ICacheAdapter => {
  if (!cacheAdapter) {
    cacheAdapter = new RedisAdapter(getCacheClient())
  }
  return cacheAdapter
}

export const messageHandlerFactory =
  (
    eventRepository: IEventRepository,
    userRepository: IUserRepository,
    nip05VerificationRepository: INip05VerificationRepository,
  ) =>
  ([message, adapter]: [IncomingMessage, IWebSocketAdapter]) => {
    switch (message[0]) {
      case MessageType.EVENT: {
        return new EventMessageHandler(
          adapter,
          eventStrategyFactory(eventRepository, userRepository),
          eventRepository,
          userRepository,
          createSettings,
          nip05VerificationRepository,
          getCache(),
          rateLimiterFactory,
        )
      }
      case MessageType.REQ:
        return new SubscribeMessageHandler(adapter, eventRepository, createSettings)
      case MessageType.CLOSE:
        return new UnsubscribeMessageHandler(adapter)
      case MessageType.COUNT:
        return new CountMessageHandler(adapter, eventRepository, createSettings)
      default:
        throw new Error(`Unknown message type: ${String(message[0]).substring(0, 64)}`)
    }
  }
