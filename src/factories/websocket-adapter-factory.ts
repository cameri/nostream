import { IncomingMessage } from 'http'
import { WebSocket } from 'ws'

import { IEventRepository, IUserRepository } from '../@types/repositories'
import { createSettings } from './settings-factory'
import { IWebSocketServerAdapter } from '../@types/adapters'
import { messageHandlerFactory } from './message-handler-factory'
import { slidingWindowRateLimiterFactory } from './rate-limiter-factory'
import { WebSocketAdapter } from '../adapters/web-socket-adapter'


export const webSocketAdapterFactory = (
  eventRepository: IEventRepository,
  userRepository: IUserRepository,
) => ([client, request, webSocketServerAdapter]: [WebSocket, IncomingMessage, IWebSocketServerAdapter]) =>
    new WebSocketAdapter(
      client,
      request,
      webSocketServerAdapter,
      messageHandlerFactory(eventRepository, userRepository),
      slidingWindowRateLimiterFactory,
      createSettings,
    )
