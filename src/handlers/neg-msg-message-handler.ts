import { createNegErrMessage, createNegMsgMessage } from '../utils/messages'
import { IMessageHandler } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import { NegMsgMessage, OutgoingMessage } from '../@types/messages'
import { Settings } from '../@types/settings'
import { WebSocketAdapterEvent } from '../constants/adapter'
import { createLogger } from '../factories/logger-factory'
import { isNip77Active } from '../utils/nip77'
import { isReconciliationAuthorized } from '../utils/nip42'

const logger = createLogger('neg-msg-message-handler')

export class NegMsgMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly settings: () => Settings,
  ) {}

  public async handleMessage(message: NegMsgMessage): Promise<void> {
    const subscriptionId = message[1]
    const sessions = this.webSocket.getNegentropySessions()

    if (!isNip77Active(this.settings())) {
      // Turned off while a session was open: end it instead of leaving it half-served.
      sessions.close(subscriptionId)
      this.reply(createNegErrMessage(subscriptionId, 'blocked: NIP-77 is disabled by relay configuration'))
      return
    }

    const session = sessions.touch(subscriptionId)
    if (!session) {
      this.reply(createNegErrMessage(subscriptionId, 'closed: unknown negentropy subscription'))
      return
    }

    // Access can lapse while a session is open (e.g. NIP-42 auth expiring), so check it every time.
    if (!isReconciliationAuthorized(this.settings(), session.filter, () => this.webSocket.getAuthenticatedPubkeys())) {
      sessions.close(subscriptionId)
      this.reply(
        createNegErrMessage(subscriptionId, 'auth-required: authentication is required to sync these event kinds'),
      )
      return
    }

    try {
      const { output } = session.negentropy.reconcile(Buffer.from(message[2], 'hex'))

      this.reply(createNegMsgMessage(subscriptionId, Buffer.from(output as Uint8Array).toString('hex')))
    } catch (error) {
      // NIP-77: after a NEG-ERR the subscription is closed.
      sessions.close(subscriptionId)
      logger('NEG-MSG %s sent a malformed negentropy message: %o', subscriptionId, error)
      this.reply(createNegErrMessage(subscriptionId, 'invalid: malformed negentropy message'))
    }
  }

  private reply(message: OutgoingMessage): void {
    this.webSocket.emit(WebSocketAdapterEvent.Message, message)
  }
}
