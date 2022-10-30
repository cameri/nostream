import { createLogger } from '../factories/logger-factory'
import { IMessageHandler } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import { UnsubscribeMessage } from '../@types/messages'
import { WebSocketAdapterEvent } from '../constants/adapter'

const debug = createLogger('unsubscribe-message-handler')

export class UnsubscribeMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
  ) { }

  public async handleMessage(message: UnsubscribeMessage): Promise<void> {
    debug('received message: %o', message)
    this.webSocket.emit(WebSocketAdapterEvent.Unsubscribe, message[1])
  }
}
