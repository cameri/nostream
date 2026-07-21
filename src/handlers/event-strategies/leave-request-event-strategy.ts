import { ICacheAdapter, IWebSocketAdapter } from '../../@types/adapters'
import { admissionCacheKey } from '../../constants/caching'
import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { Event } from '../../@types/event'
import { IEventStrategy } from '../../@types/message-handlers'
import { isNip43RequestTimestampValid } from '../../utils/nip43'
import { isProtectedEvent } from '../../utils/event'
import { IUserRepository } from '../../@types/repositories'
import { Settings } from '../../@types/settings'
import { WebSocketAdapterEvent } from '../../constants/adapter'

const logger = createLogger('leave-request-event-strategy')

export class LeaveRequestEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly userRepository: IUserRepository,
    private readonly cache: ICacheAdapter,
    private readonly settings: () => Settings,
  ) {}

  public async execute(event: Event): Promise<void> {
    const currentSettings = this.settings()

    if (!currentSettings.nip43?.enabled) {
      logger('NIP-43 disabled, rejecting leave request from %s', event.pubkey)
      this.sendResult(event.id, false, 'restricted: NIP-43 is not enabled on this relay')
      return
    }

    // NIP-43 requires leave requests to carry a NIP-70 "-" tag
    if (!isProtectedEvent(event)) {
      logger('leave request from %s missing "-" tag', event.pubkey)
      this.sendResult(event.id, false, 'invalid: leave request requires a NIP-70 "-" tag')
      return
    }

    if (!isNip43RequestTimestampValid(event)) {
      logger('leave request from %s has stale created_at', event.pubkey)
      this.sendResult(event.id, false, 'invalid: created_at is too far from the current time')
      return
    }

    if (!this.webSocket.getAuthenticatedPubkeys().has(event.pubkey)) {
      logger('unauthenticated leave request from %s', event.pubkey)
      this.sendResult(event.id, false, 'auth-required: authentication required (NIP-42)')
      return
    }

    // Avoids creating phantom user rows for non-members.
    const existingUser = await this.userRepository.findByPubkey(event.pubkey)
    if (!existingUser?.isAdmitted) {
      logger('leave request from %s: not currently admitted', event.pubkey)
      this.sendResult(event.id, true, '')
      return
    }

    await this.userRepository.revokeAdmission(event.pubkey)

    // Drop any cached "admitted" verdict so the departed member can't keep
    // publishing on a stale admission cache entry.
    try {
      await this.cache.deleteKey(admissionCacheKey(event.pubkey))
    } catch (error) {
      logger('unable to invalidate admission cache for %s: %o', event.pubkey, error)
    }

    logger('revoked admission for %s', event.pubkey)
    this.sendResult(event.id, true, '')
  }

  private sendResult(eventId: string, successful: boolean, message: string): void {
    this.webSocket.emit(WebSocketAdapterEvent.Message, createEventCommandResult(eventId, successful, message))
  }
}
