import { IInviteCodeRepository, IUserRepository } from '../../@types/repositories'
import { createCommandResult } from '../../utils/messages'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { getClaimTag } from '../../utils/nip43'
import { IEventStrategy } from '../../@types/message-handlers'
import { IWebSocketAdapter } from '../../@types/adapters'
import { Settings } from '../../@types/settings'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('join-request-event-strategy')

export class JoinRequestEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly inviteCodeRepository: IInviteCodeRepository,
    private readonly userRepository: IUserRepository,
    private readonly settings: () => Settings,
  ) {}

  public async execute(event: Event): Promise<void> {
    const currentSettings = this.settings()

    if (!currentSettings.nip43?.enabled) {
      logger('NIP-43 disabled, rejecting join request from %s', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'restricted: NIP-43 is not enabled on this relay'),
      )
      return
    }

    if (!this.webSocket.getAuthenticatedPubkeys().has(event.pubkey)) {
      logger('unauthenticated join request from %s', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'restricted: authentication required (NIP-42)'),
      )
      return
    }

    const claimCode = getClaimTag(event)
    if (!claimCode) {
      logger('join request from %s missing claim tag', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'restricted: missing claim tag'),
      )
      return
    }

    const existingUser = await this.userRepository.findByPubkey(event.pubkey)
    if (existingUser?.isAdmitted) {
      logger('join request from %s: already admitted', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, true, 'duplicate: you are already a member of this relay'),
      )
      return
    }

    const claimed = await this.inviteCodeRepository.claimCode(claimCode, event.pubkey)
    if (!claimed) {
      logger('join request from %s: claim failed', event.pubkey)
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'restricted: invalid or expired invite code'),
      )
      return
    }

    const now = new Date()
    await this.userRepository.admitUser(event.pubkey, now)

    const relayUrl = currentSettings.info?.relay_url ?? 'this relay'
    logger('admitted %s via invite code', event.pubkey)
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createCommandResult(event.id, true, `info: welcome to ${relayUrl}!`),
    )
  }
}
