import { IncomingMessage } from 'http'
import { WebSocket } from 'ws'

import { IEventRepository } from '../@types/repositories'
import { IWebSocketServerAdapter } from '../@types/adapters'
import { messageHandlerFactory } from './message-handler-factory'
import { WebSocketAdapter } from '../adapters/web-socket-adapter'


export const webSocketAdapterFactory = (
  eventRepository: IEventRepository,
) => ([client, request, webSocketServerAdapter]: [WebSocket, IncomingMessage, IWebSocketServerAdapter]) =>
    new WebSocketAdapter(
      client,
      request,
      webSocketServerAdapter,
      messageHandlerFactory(eventRepository)
    )
