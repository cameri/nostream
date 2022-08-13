import { WebSocket } from 'ws'
import { IWebSocketServerAdapter } from '../@types/adapters'
import { IEventRepository } from '../@types/repositories'
import { WebSocketAdapter } from '../adapters/web-socket-adapter'
import { messageHandlerFactory } from './message-handler-factory'


export const webSocketAdapterFactory = (
  eventRepository: IEventRepository,
) => ([client, webSocketServerAdapter]: [WebSocket, IWebSocketServerAdapter,]) =>
    new WebSocketAdapter(
      client,
      webSocketServerAdapter,
      messageHandlerFactory(eventRepository)
    )
