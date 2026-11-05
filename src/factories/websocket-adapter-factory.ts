import { IncomingMessage } from 'http'
import { WebSocket } from 'ws'
import { IWebSocketServerAdapter } from '../@types/adapters'
import {
  IDvmJobRepository,
  IEventRepository,
  IInviteCodeRepository,
  INip05VerificationRepository,
  IReportRepository,
  IUserRepository,
} from '../@types/repositories'
import { WebSocketAdapter } from '../adapters/web-socket-adapter'
import { getPeerRequestStatsStore, messageHandlerFactory } from './message-handler-factory'
import { rateLimiterFactory } from './rate-limiter-factory'
import { createSettings } from './settings-factory'

export const webSocketAdapterFactory =
  (
    eventRepository: IEventRepository,
    userRepository: IUserRepository,
    nip05VerificationRepository: INip05VerificationRepository,
    inviteCodeRepository: IInviteCodeRepository,
    dvmJobRepository: IDvmJobRepository,
    reportRepository: IReportRepository,
  ) =>
  ([client, request, webSocketServerAdapter]: [WebSocket, IncomingMessage, IWebSocketServerAdapter]) =>
    new WebSocketAdapter(
      client,
      request,
      webSocketServerAdapter,
      messageHandlerFactory(
        eventRepository,
        userRepository,
        nip05VerificationRepository,
        inviteCodeRepository,
        dvmJobRepository,
        reportRepository,
      ),
      rateLimiterFactory,
      createSettings,
      getPeerRequestStatsStore(),
    )
