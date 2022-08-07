import { WebSocket } from 'ws'

import { Message, MessageType } from './messages'

export interface IMessageHandler {
  canHandleMessageType(messageType: MessageType): boolean
  handleMessage(message: Message, client: WebSocket): Promise<boolean>
}
