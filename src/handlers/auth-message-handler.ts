import { EventKinds, EventTags } from '../constants/base'
import { isEventIdValid, isEventSignatureValid } from '../utils/event'
import { AuthMessage } from '../@types/messages'
import { createCommandResult } from '../utils/messages'
import { createLogger } from '../factories/logger-factory'
import { IMessageHandler } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import { Settings } from '../@types/settings'
import { WebSocketAdapterEvent } from '../constants/adapter'

const logger = createLogger('auth-message-handler')

const AUTH_EVENT_KIND = EventKinds.AUTH // 22242
const MAX_TIMESTAMP_DELTA_SECONDS = 600 // 10 minutes

export class AuthMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly settings: () => Settings,
  ) {}

  public async handleMessage(message: AuthMessage): Promise<void> {
    const event = message[1]

    if (event.kind !== AUTH_EVENT_KIND) {
      this.sendResult(event.id, false, 'invalid: auth event must be kind 22242')
      return
    }

    if (!(await isEventIdValid(event))) {
      this.sendResult(event.id, false, 'invalid: event id does not match')
      return
    }

    if (!(await isEventSignatureValid(event))) {
      this.sendResult(event.id, false, 'invalid: event signature verification failed')
      return
    }

    const now = Math.floor(Date.now() / 1000)
    const delta = Math.abs(now - event.created_at)
    if (delta > MAX_TIMESTAMP_DELTA_SECONDS) {
      this.sendResult(event.id, false, 'invalid: created_at is too far from the current time')
      return
    }

    const challengeTag = event.tags.find(
      (tag) => tag.length >= 2 && tag[0] === EventTags.Challenge,
    )
    if (!challengeTag || challengeTag[1] !== this.webSocket.getChallenge()) {
      this.sendResult(event.id, false, 'invalid: challenge does not match')
      return
    }

    const relayTag = event.tags.find(
      (tag) => tag.length >= 2 && tag[0] === EventTags.AuthRelay,
    )
    const relayUrl = this.settings().info.relay_url
    if (!relayTag || !this.isRelayUrlMatch(relayTag[1], relayUrl)) {
      this.sendResult(event.id, false, 'invalid: relay url does not match')
      return
    }

    logger('client %s authenticated as %s', this.webSocket.getClientId(), event.pubkey)
    this.webSocket.addAuthenticatedPubkey(event.pubkey)
    this.sendResult(event.id, true, '')
  }

  private sendResult(eventId: string, success: boolean, message: string): void {
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createCommandResult(eventId, success, message),
    )
  }

  // NIP-42 says domain-match is sufficient for relay URL comparison
  private isRelayUrlMatch(clientRelay: string, serverRelay: string): boolean {
    try {
      const clientHost = new URL(clientRelay).hostname.toLowerCase()
      const serverHost = new URL(serverRelay).hostname.toLowerCase()
      return clientHost === serverHost
    } catch {
      return false
    }
  }
}
