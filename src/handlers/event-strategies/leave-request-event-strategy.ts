import { IUserRepository } from '../../@types/repositories'
import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { Settings } from '../../@types/settings'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('leave-request-event-strategy')

export class LeaveRequestEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly userRepository: IUserRepository,
    private readonly settings: () => Settings,
  ) {}

  public async execute(event: Event): Promise<void> {
    const currentSettings = this.settings()

    if (!currentSettings.nip43?.enabled) {
      logger('NIP-43 disabled, rejecting leave request from %s', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'restricted: NIP-43 is not enabled on this relay'),
      )
      return
    }

    if (!this.webSocket.getAuthenticatedPubkeys().has(event.pubkey)) {
      logger('unauthenticated leave request from %s', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'restricted: authentication required (NIP-42)'),
      )
      return
    }

    // Avoids creating phantom user rows for non-members.
    const existingUser = await this.userRepository.findByPubkey(event.pubkey)
    if (!existingUser?.isAdmitted) {
      logger('leave request from %s: not currently admitted', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, true, ''),
      )
      return
    }

    await this.userRepository.upsert({
      pubkey: event.pubkey,
      isAdmitted: false,
    })

    logger('revoked admission for %s', event.pubkey)
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createCommandResult(event.id, true, ''),
    )
  }
}
