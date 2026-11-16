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
import { IPeeringBillingService } from '../@types/services'
import { RedisAdapter } from '../adapters/redis-adapter'
import { getCacheClient } from '../cache/client'
import { getMasterDbClient } from '../database/client'
import { AuthMessageHandler } from '../handlers/auth-message-handler'
import { CountMessageHandler } from '../handlers/count-message-handler'
import { EventMessageHandler } from '../handlers/event-message-handler'
import { NegCloseMessageHandler } from '../handlers/neg-close-message-handler'
import { NegMsgMessageHandler } from '../handlers/neg-msg-message-handler'
import { NegOpenMessageHandler } from '../handlers/neg-open-message-handler'
import { SubscribeMessageHandler } from '../handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from '../handlers/unsubscribe-message-handler'
import { UserSubscriptionRepository } from '../repositories/user-subscription-repository'
import { PeeringRequestStatsStore } from '../utils/peering-request-stats'
import { eventStrategyFactory } from './event-strategy-factory'
import { createPeeringBillingService } from './peering-billing-service-factory'
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

let userSubscriptionRepository: UserSubscriptionRepository | undefined = undefined
const getUserSubscriptionRepository = (): UserSubscriptionRepository => {
  if (!userSubscriptionRepository) {
    userSubscriptionRepository = new UserSubscriptionRepository(getMasterDbClient())
  }
  return userSubscriptionRepository
}

let peerRequestStatsStore: PeeringRequestStatsStore | undefined = undefined
export const getPeerRequestStatsStore = (): PeeringRequestStatsStore => {
  if (!peerRequestStatsStore) {
    peerRequestStatsStore = new PeeringRequestStatsStore(getCache())
  }
  return peerRequestStatsStore
}

let peeringBillingService: IPeeringBillingService | undefined = undefined
export const getPeeringBillingService = (): IPeeringBillingService => {
  if (!peeringBillingService) {
    peeringBillingService = createPeeringBillingService()
  }
  return peeringBillingService
}

/**
 * Only a connection that proved a configured peer identity needs billing. Creating
 * the billing service eagerly would build a payments processor for every ordinary
 * REQ/COUNT/NEG-OPEN, which can fail before the handler runs when a payment
 * provider is misconfigured.
 */
export const peeringBillingServiceFor = (
  adapter: IWebSocketAdapter,
  get: () => IPeeringBillingService = getPeeringBillingService,
): IPeeringBillingService | undefined => (adapter.getPeerPubkey?.() ? get() : undefined)

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
          getUserSubscriptionRepository(),
        )
      }
      case MessageType.REQ:
        return new SubscribeMessageHandler(
          adapter,
          eventRepository,
          createSettings,
          inviteCodeRepository,
          rateLimiterFactory,
          getPeerRequestStatsStore(),
          peeringBillingServiceFor(adapter),
        )
      case MessageType.CLOSE:
        return new UnsubscribeMessageHandler(adapter)
      case MessageType.COUNT:
        return new CountMessageHandler(
          adapter,
          eventRepository,
          createSettings,
          rateLimiterFactory,
          getPeerRequestStatsStore(),
          peeringBillingServiceFor(adapter),
        )
      case MessageType.AUTH:
        return new AuthMessageHandler(adapter, createSettings)
      case MessageType.NEG_OPEN:
        return new NegOpenMessageHandler(
          adapter,
          eventRepository,
          createSettings,
          rateLimiterFactory,
          getPeerRequestStatsStore(),
          peeringBillingServiceFor(adapter),
        )
      case MessageType.NEG_MSG:
        return new NegMsgMessageHandler(adapter, createSettings, peeringBillingServiceFor(adapter))
      case MessageType.NEG_CLOSE:
        return new NegCloseMessageHandler(adapter)
      default:
        throw new Error(`Unknown message type: ${String(message[0]).substring(0, 64)}`)
    }
  }
