import { IMessageHandler } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import { UnsubscribeMessage } from '../@types/messages'
import { WebSocketAdapterEvent } from '../constants/adapter'

export class UnsubscribeMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  public async handleMessage(message: UnsubscribeMessage): Promise<void> {
    this.webSocket.emit(WebSocketAdapterEvent.Unsubscribe, message[1])
  }
}
