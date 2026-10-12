import { IMessageHandler } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import { NegCloseMessage } from '../@types/messages'

export class NegCloseMessageHandler implements IMessageHandler {
  public constructor(private readonly webSocket: IWebSocketAdapter) {}

  // NIP-77 defines no reply to NEG-CLOSE, and closing an unknown id is harmless.
  public async handleMessage(message: NegCloseMessage): Promise<void> {
    this.webSocket.getNegentropySessions().close(message[1])
  }
}
