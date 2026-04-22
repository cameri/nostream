import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { EventTags } from '../../constants/base'
import { IEventRepository } from '../../@types/repositories'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { validateNip44Payload } from '../../utils/nip44'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('gift-wrap-event-strategy')

export class GiftWrapEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) {}

  public async execute(event: Event): Promise<void> {
    logger('received gift wrap event: %o', event)

    const reason = this.validateGiftWrap(event)
    if (reason) {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, `invalid: ${reason}`))
      return
    }

    const count = await this.eventRepository.create(event)
    this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, true, count ? '' : 'duplicate:'))

    if (count) {
      this.webSocket.emit(WebSocketAdapterEvent.Broadcast, event)
    }
  }

  private validateGiftWrap(event: Event): string | undefined {
    // NIP-17: gift wrap MUST have exactly one p tag (one recipient per wrap)
    const recipientTags = event.tags.filter((tag) => tag.length >= 2 && tag[0] === EventTags.Pubkey)

    if (recipientTags.length === 0) {
      return 'gift wrap event (kind 1059) must have a p tag identifying the recipient'
    }

    if (recipientTags.length > 1) {
      return 'gift wrap event (kind 1059) must have exactly one p tag'
    }

    const recipientPubkey = recipientTags[0][1]
    if (!/^[0-9a-f]{64}$/.test(recipientPubkey)) {
      return 'gift wrap event (kind 1059) p tag must contain a valid 64-character lowercase hex pubkey'
    }

    // Validate that the content is a structurally valid NIP-44 v2 payload
    const payloadError = validateNip44Payload(event.content)
    if (payloadError) {
      return `gift wrap content must be a valid NIP-44 v2 payload: ${payloadError}`
    }

    return undefined
  }
}
