import { WebSocket } from 'ws'

import { Message, MessageType } from './messages'
import { IWebSocketServerAdapter } from './servers'

export interface IMessageHandler {
  canHandleMessageType(messageType: MessageType): boolean
  handleMessage(message: Message, client: WebSocket, adapter: IWebSocketServerAdapter): Promise<boolean>
}
