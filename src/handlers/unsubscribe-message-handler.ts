import { IWebSocketAdapter } from '../@types/adapters'

import { IMessageHandler } from '../@types/message-handlers'
import { UnsubscribeMessage } from '../@types/messages'


export class UnsubscribeMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  public async handleMessage(message: UnsubscribeMessage): Promise<void> {
    this.webSocket.emit('unsubscribe', message[1])
  }
}
