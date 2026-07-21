import { getClaimTag, isNip43RequestTimestampValid } from '../../utils/nip43'
import { ICacheAdapter, IWebSocketAdapter } from '../../@types/adapters'
import { IInviteCodeRepository, IUserRepository } from '../../@types/repositories'
import { admissionCacheKey } from '../../constants/caching'
import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { Settings } from '../../@types/settings'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('join-request-event-strategy')

// Join requests are answered with an OK result but never broadcast to
// subscribers: the claim tag would leak the invite code to anyone
// subscribed to kind 28934.
export class JoinRequestEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly inviteCodeRepository: IInviteCodeRepository,
    private readonly userRepository: IUserRepository,
    private readonly cache: ICacheAdapter,
    private readonly settings: () => Settings,
  ) {}

  public async execute(event: Event): Promise<void> {
    const currentSettings = this.settings()

    if (!currentSettings.nip43?.enabled) {
      logger('NIP-43 disabled, rejecting join request from %s', event.pubkey)
      this.sendResult(event.id, false, 'restricted: NIP-43 is not enabled on this relay')
      return
    }

    if (!isNip43RequestTimestampValid(event)) {
      logger('join request from %s has stale created_at', event.pubkey)
      this.sendResult(event.id, false, 'invalid: created_at is too far from the current time')
      return
    }

    if (!this.webSocket.getAuthenticatedPubkeys().has(event.pubkey)) {
      logger('unauthenticated join request from %s', event.pubkey)
      this.sendResult(event.id, false, 'auth-required: authentication required (NIP-42)')
      return
    }

    const claimCode = getClaimTag(event)
    if (!claimCode) {
      logger('join request from %s missing claim tag', event.pubkey)
      this.sendResult(event.id, false, 'invalid: join request requires a claim tag')
      return
    }

    const existingUser = await this.userRepository.findByPubkey(event.pubkey)
    if (existingUser?.isAdmitted) {
      logger('join request from %s: already admitted', event.pubkey)
      this.sendResult(event.id, true, 'duplicate: you are already a member of this relay')
      return
    }

    const claimed = await this.inviteCodeRepository.claimCode(claimCode, event.pubkey)
    if (!claimed) {
      logger('join request from %s: claim failed', event.pubkey)
      this.sendResult(event.id, false, 'restricted: invalid or expired invite code')
      return
    }

    // Not transactional with claimCode: if admitUser throws, one code use is
    // wasted. Acceptable — the alternative order (admit before claim) could
    // admit users without a valid code.
    await this.userRepository.admitUser(event.pubkey, new Date())

    // Drop any cached "not admitted" verdict so the new member's next event
    // isn't rejected by a stale admission cache entry.
    try {
      await this.cache.deleteKey(admissionCacheKey(event.pubkey))
    } catch (error) {
      logger('unable to invalidate admission cache for %s: %o', event.pubkey, error)
    }

    const relayUrl = currentSettings.info?.relay_url ?? 'this relay'
    logger('admitted %s via invite code', event.pubkey)
    this.sendResult(event.id, true, `info: welcome to ${relayUrl}!`)
  }

  private sendResult(eventId: string, successful: boolean, message: string): void {
    this.webSocket.emit(WebSocketAdapterEvent.Message, createEventCommandResult(eventId, successful, message))
  }
}
