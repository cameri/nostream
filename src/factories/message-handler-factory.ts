import { ICacheAdapter, IWebSocketAdapter } from '../@types/adapters'
import { IncomingMessage, MessageType } from '../@types/messages'
import {
  IDvmJobRepository,
  IEventRepository,
  IInviteCodeRepository,
  INip05VerificationRepository,
  IReportRepository,
  IUserRepository,
} from '../@types/repositories'
import { RedisAdapter } from '../adapters/redis-adapter'
import { getCacheClient } from '../cache/client'
import { AuthMessageHandler } from '../handlers/auth-message-handler'
import { CountMessageHandler } from '../handlers/count-message-handler'
import { EventMessageHandler } from '../handlers/event-message-handler'
import { SubscribeMessageHandler } from '../handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from '../handlers/unsubscribe-message-handler'
import { eventStrategyFactory } from './event-strategy-factory'
import { rateLimiterFactory } from './rate-limiter-factory'
import { createSettings } from './settings-factory'
import { wotGraphServiceFactory } from './wot-graph-service-factory'

let cacheAdapter: ICacheAdapter | undefined = undefined
export const getCache = (): ICacheAdapter => {
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
    inviteCodeRepository: IInviteCodeRepository,
    dvmJobRepository: IDvmJobRepository,
    reportRepository: IReportRepository,
  ) =>
  ([message, adapter]: [IncomingMessage, IWebSocketAdapter]) => {
    switch (message[0]) {
      case MessageType.EVENT: {
        return new EventMessageHandler(
          adapter,
          eventStrategyFactory(
            eventRepository,
            userRepository,
            inviteCodeRepository,
            dvmJobRepository,
            reportRepository,
            getCache(),
            createSettings,
          ),
          eventRepository,
          userRepository,
          createSettings,
          nip05VerificationRepository,
          getCache(),
          rateLimiterFactory,
          wotGraphServiceFactory(getCache(), eventRepository, createSettings),
        )
      }
      case MessageType.REQ:
        return new SubscribeMessageHandler(
          adapter,
          eventRepository,
          createSettings,
          inviteCodeRepository,
          rateLimiterFactory,
        )
      case MessageType.CLOSE:
        return new UnsubscribeMessageHandler(adapter)
      case MessageType.COUNT:
        return new CountMessageHandler(adapter, eventRepository, createSettings)
      case MessageType.AUTH:
        return new AuthMessageHandler(adapter, createSettings)
      default:
        throw new Error(`Unknown message type: ${String(message[0]).substring(0, 64)}`)
    }
  }
