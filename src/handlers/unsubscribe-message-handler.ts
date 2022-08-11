import { WebSocket } from 'ws'

import { IMessageHandler } from '../@types/message-handlers'
import { UnsubscribeMessage } from '../@types/messages'
import { IWebSocketServerAdapter } from '../@types/servers'


export class UnsubscribeMessageHandler implements IMessageHandler {
  public constructor(
    private readonly adapter: IWebSocketServerAdapter,
  ) { }

  public async handleMessage(message: UnsubscribeMessage, client: WebSocket): Promise<void> {
    const subscriptionId = message[1]

    this.adapter.getSubscriptions(client)?.delete(subscriptionId)
  }
}
