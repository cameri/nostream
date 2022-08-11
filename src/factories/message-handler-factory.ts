import { EventMessageHandler } from '../handlers/event-message-handler'
import { SubscribeMessageHandler } from '../handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from '../handlers/unsubscribe-message-handler'
import { Message, MessageType } from '../@types/messages'
import { IEventRepository } from '../@types/repositories'
import { IWebSocketServerAdapter } from '../@types/servers'
import { createEventStrategyFactory } from './event-strategy-factory'


export const createMessageHandlerFactory = (
  eventRepository: IEventRepository,
) => ([message, adapter]: [Message, IWebSocketServerAdapter]) => {
  console.debug('Received message', message)
  switch (message[0]) {
    case MessageType.EVENT:
      return new EventMessageHandler(createEventStrategyFactory(adapter, eventRepository))
    case MessageType.REQ:
      return new SubscribeMessageHandler(adapter, eventRepository)
    case MessageType.CLOSE:
      return new UnsubscribeMessageHandler(adapter)
    default:
      throw new Error(`Unknown message type: ${String(message[0])}`)
  }
}
