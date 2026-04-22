import { EventKinds, EventTags } from '../constants/base'
import { IMessageHandler } from '../@types/message-handlers'
import { isEventIdValid, isEventSignatureValid } from '../utils/event'
import { AuthMessage } from '../@types/messages'
import { createLogger } from '../factories/logger-factory'
import { Factory } from '../@types/base'
import { IWebSocketAdapter } from '../@types/adapters'
import { Settings } from '../@types/settings'

const logger = createLogger('auth-message-handler')

export class AuthMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly settings: Factory<Settings>,
  ) {}

  public async handleMessage(message: AuthMessage): Promise<void> {
    const event = message[1]
    const clientId = this.webSocket.getClientId()

    if (event.kind !== EventKinds.AUTH) {
      logger('client %s sent invalid auth event kind: %d', clientId, event.kind)
      return
    }

    const isValid = (await isEventIdValid(event)) && (await isEventSignatureValid(event))
    if (!isValid) {
      logger('client %s sent invalid auth event signature: %s', clientId, event.id)
      return
    }

    const challenge = event.tags.find((tag) => tag[0] === EventTags.Challenge)?.[1]
    if (challenge !== this.webSocket.getChallenge()) {
      logger('client %s sent invalid auth challenge: expected %s, got %s', clientId, this.webSocket.getChallenge(), challenge)
      return
    }

    const relay = event.tags.find((tag) => tag[0] === EventTags.Relay)?.[1]
    const configuredRelayUrl = this.settings().info.relay_url
    if (relay !== configuredRelayUrl) {
      logger('client %s sent invalid auth relay: expected %s, got %s', clientId, configuredRelayUrl, relay)
      return
    }

    // NIP-42: event must be recent (e.g., within 10 minutes)
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(event.created_at - now) > 600) {
      logger('client %s sent expired auth event: %d (now: %d)', clientId, event.created_at, now)
      return
    }

    // In a real implementation, we would associate the pubkey with the client session.
    logger('client %s authenticated as %s', clientId, event.pubkey)
  }
}
