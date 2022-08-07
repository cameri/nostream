import { WebSocket } from 'ws'

import { IMessageHandler } from '../types/message-handlers'
import { MessageType, UnsubscribeMessage } from '../types/messages'
import { IWebSocketServerAdapter } from '../types/servers'


export class UnsubscribeMessageHandler implements IMessageHandler {
  public constructor(
    private readonly adapter: IWebSocketServerAdapter,
  ) { }

  public canHandleMessageType(messageType: MessageType): boolean {
    return messageType === MessageType.CLOSE
  }

  public async handleMessage(message: UnsubscribeMessage, client: WebSocket): Promise<boolean> {
    const subscriptionId = message[1]

    this.adapter.getSubscriptions(client)?.delete(subscriptionId)

    return true
  }
}