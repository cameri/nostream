import { ContextMetadataKey, EventExpirationTimeMetadataKey, EventKinds } from '../constants/base'
import {
  DEFAULT_NIP05_VERIFY_EXPIRATION_MS,
  extractNip05FromEvent,
  isDomainAllowed,
  Nip05VerificationOutcome,
  parseNip05Identifier,
  verifyNip05Identifier,
} from '../utils/nip05'
import { Event, ExpiringEvent } from '../@types/event'
import { EventRateLimit, FeeSchedule, Settings } from '../@types/settings'
import {
  getEventExpiration,
  getEventProofOfWork,
  getPubkeyProofOfWork,
  getPublicKey,
  getRelayPrivateKey,
  isDirectMessageEvent,
  isEventIdValid,
  isEventKindOrRangeMatch,
  isEventSignatureValid,
  isExpiredEvent,
  isFileMessageEvent,
  isRequestToVanishEvent,
  isSealEvent,
  isWelcomeRumorEvent,
} from '../utils/event'
import { IEventRepository, INip05VerificationRepository, IUserRepository } from '../@types/repositories'
import { IEventStrategy, IMessageHandler } from '../@types/message-handlers'
import { CacheAdmissionState } from '../constants/caching'
import { createCommandResult } from '../utils/messages'
import { createLogger } from '../factories/logger-factory'
import { Factory } from '../@types/base'
import { ICacheAdapter } from '../@types/adapters'
import { IncomingEventMessage } from '../@types/messages'
import { IRateLimiter } from '../@types/utils'
import { IWebSocketAdapter } from '../@types/adapters'
import { Nip05Verification } from '../@types/nip05'
import { WebSocketAdapterEvent } from '../constants/adapter'

const logger = createLogger('event-message-handler')

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    protected readonly webSocket: IWebSocketAdapter,
    protected readonly strategyFactory: Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]>,
    protected readonly eventRepository: IEventRepository,
    protected readonly userRepository: IUserRepository,
    private readonly settings: () => Settings,
    private readonly nip05VerificationRepository: INip05VerificationRepository,
    private readonly cache: ICacheAdapter,
    private readonly rateLimiter: Factory<IRateLimiter>,
  ) {}

  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    let [, event] = message

    event[ContextMetadataKey] = message[ContextMetadataKey]

    let reason = await this.isEventValid(event)
    if (reason) {
      logger('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    if (isExpiredEvent(event)) {
      logger('event %s rejected: expired')
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'event is expired'))
      return
    }

    event = this.addExpirationMetadata(event)

    if (await this.isRateLimited(event)) {
      logger('event %s rejected: rate-limited')
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'rate-limited: slow down'),
      )
      return
    }

    reason = this.canAcceptEvent(event)
    if (reason) {
      logger('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    reason = await this.isBlockedByRequestToVanish(event)
    if (reason) {
      logger('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    reason = await this.isUserAdmitted(event)
    if (reason) {
      logger('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    reason = await this.checkNip05Verification(event)
    if (reason) {
      logger('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    const strategy = this.strategyFactory([event, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      this.webSocket.emit(
        WebSocketAdapterEvent.Message,
        createCommandResult(event.id, false, 'error: event not supported'),
      )
      return
    }

    try {
      await strategy.execute(event)
      this.processNip05Metadata(event)
    } catch (error) {
      logger.error('error handling message', message, error)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'error: unable to process event'))
    }
  }

  protected getRelayPublicKey(): string {
    const relayPrivkey = getRelayPrivateKey(this.settings().info.relay_url)
    return getPublicKey(relayPrivkey)
  }

  protected canAcceptEvent(event: Event): string | undefined {
    if (this.getRelayPublicKey() === event.pubkey) {
      return
    }
    const now = Math.floor(Date.now() / 1000)

    const limits = this.settings().limits?.event ?? {}

    if (Array.isArray(limits.content)) {
      for (const limit of limits.content) {
        if (
          typeof limit.maxLength !== 'undefined' &&
          limit.maxLength > 0 &&
          event.content.length > limit.maxLength &&
          (!Array.isArray(limit.kinds) || limit.kinds.some(isEventKindOrRangeMatch(event)))
        ) {
          return `rejected: content is longer than ${limit.maxLength} bytes`
        }
      }
    } else if (
      typeof limits.content?.maxLength !== 'undefined' &&
      limits.content?.maxLength > 0 &&
      event.content.length > limits.content.maxLength &&
      (!Array.isArray(limits.content.kinds) || limits.content.kinds.some(isEventKindOrRangeMatch(event)))
    ) {
      return `rejected: content is longer than ${limits.content.maxLength} bytes`
    }

    if (
      typeof limits.createdAt?.maxPositiveDelta !== 'undefined' &&
      limits.createdAt.maxPositiveDelta > 0 &&
      event.created_at > now + limits.createdAt.maxPositiveDelta
    ) {
      return `rejected: created_at is more than ${limits.createdAt.maxPositiveDelta} seconds in the future`
    }

    if (
      typeof limits.createdAt?.maxNegativeDelta !== 'undefined' &&
      limits.createdAt.maxNegativeDelta > 0 &&
      event.created_at < now - limits.createdAt.maxNegativeDelta
    ) {
      return `rejected: created_at is more than ${limits.createdAt.maxNegativeDelta} seconds in the past`
    }

    if (typeof limits.eventId?.minLeadingZeroBits !== 'undefined' && limits.eventId.minLeadingZeroBits > 0) {
      const pow = getEventProofOfWork(event.id)
      if (pow < limits.eventId.minLeadingZeroBits) {
        return `pow: difficulty ${pow}<${limits.eventId.minLeadingZeroBits}`
      }
    }

    if (typeof limits.pubkey?.minLeadingZeroBits !== 'undefined' && limits.pubkey.minLeadingZeroBits > 0) {
      const pow = getPubkeyProofOfWork(event.pubkey)
      if (pow < limits.pubkey.minLeadingZeroBits) {
        return `pow: pubkey difficulty ${pow}<${limits.pubkey.minLeadingZeroBits}`
      }
    }

    if (
      typeof limits.pubkey?.whitelist !== 'undefined' &&
      limits.pubkey.whitelist.length > 0 &&
      !limits.pubkey.whitelist.includes(event.pubkey)
    ) {
      return 'blocked: pubkey not allowed'
    }

    if (
      typeof limits.pubkey?.blacklist !== 'undefined' &&
      limits.pubkey.blacklist.length > 0 &&
      limits.pubkey.blacklist.includes(event.pubkey)
    ) {
      return 'blocked: pubkey not allowed'
    }

    if (
      typeof limits.kind?.whitelist !== 'undefined' &&
      limits.kind.whitelist.length > 0 &&
      !limits.kind.whitelist.some(isEventKindOrRangeMatch(event))
    ) {
      return `blocked: event kind ${event.kind} not allowed`
    }

    if (
      typeof limits.kind?.blacklist !== 'undefined' &&
      limits.kind.blacklist.length > 0 &&
      limits.kind.blacklist.some(isEventKindOrRangeMatch(event))
    ) {
      return `blocked: event kind ${event.kind} not allowed`
    }
  }

  protected async isEventValid(event: Event): Promise<string | undefined> {
    if (!(await isEventIdValid(event))) {
      return 'invalid: event id does not match'
    }
    if (!(await isEventSignatureValid(event))) {
      return 'invalid: event signature verification failed'
    }

    if (event.kind === EventKinds.REQUEST_TO_VANISH && !isRequestToVanishEvent(event, this.settings().info.relay_url)) {
      return 'invalid: request to vanish relay tag invalid'
    }

    // NIP-17: kind 13 (Seal) and kind 14 (Direct Message) are inner events that
    // must never be published directly to a relay. They are encrypted inside a
    // kind 1059 Gift Wrap (NIP-59) before being sent here.
    // Marmot MIP-02: kind 444 (Welcome rumor) is similarly an inner event that
    // must only be delivered inside a kind 1059 gift wrap.
    if (isSealEvent(event) || isDirectMessageEvent(event) || isFileMessageEvent(event) || isWelcomeRumorEvent(event)) {
      return `blocked: kind ${event.kind} events must not be published directly; wrap them in a kind 1059 gift wrap`
    }
  }

  protected async isBlockedByRequestToVanish(event: Event): Promise<string | undefined> {
    if (isRequestToVanishEvent(event)) {
      return
    }

    const relayPubkey = this.getRelayPublicKey()
    if (relayPubkey === event.pubkey) {
      return
    }

    const isVanished = await this.userRepository.isVanished(event.pubkey)
    if (isVanished) {
      return 'blocked: request to vanish active for pubkey'
    }
  }

  protected async isRateLimited(event: Event): Promise<boolean> {
    if (this.getRelayPublicKey() === event.pubkey) {
      return false
    }

    const { whitelists, rateLimits } = this.settings().limits?.event ?? {}
    if (!rateLimits || !rateLimits.length) {
      return false
    }

    if (
      typeof whitelists?.pubkeys !== 'undefined' &&
      Array.isArray(whitelists?.pubkeys) &&
      whitelists.pubkeys.includes(event.pubkey)
    ) {
      return false
    }

    if (
      typeof whitelists?.ipAddresses !== 'undefined' &&
      Array.isArray(whitelists?.ipAddresses) &&
      whitelists.ipAddresses.includes(this.webSocket.getClientAddress())
    ) {
      return false
    }

    const rateLimiter = this.rateLimiter()

    const toString = (input: any | any[]): string => {
      return Array.isArray(input) ? `[${input.map(toString)}]` : input.toString()
    }

    const hit = ({ period, rate, kinds = undefined }: EventRateLimit) => {
      const key = Array.isArray(kinds)
        ? `${event.pubkey}:events:${period}:${toString(kinds)}`
        : `${event.pubkey}:events:${period}`

      return rateLimiter.hit(key, 1, { period, rate })
    }

    let limited = false
    for (const { rate, period, kinds } of rateLimits) {
      // skip if event kind does not apply
      if (Array.isArray(kinds) && !kinds.some(isEventKindOrRangeMatch(event))) {
        continue
      }

      const isRateLimited = await hit({ period, rate, kinds })

      if (isRateLimited) {
        logger('rate limited %s: %d events / %d ms exceeded', event.pubkey, rate, period)

        limited = true
      }
    }

    return limited
  }

  protected async isUserAdmitted(event: Event): Promise<string | undefined> {
    const currentSettings = this.settings()
    if (!currentSettings.payments?.enabled) {
      return
    }

    if (this.getRelayPublicKey() === event.pubkey) {
      return
    }

    const isApplicableFee = (feeSchedule: FeeSchedule) =>
      feeSchedule.enabled &&
      !feeSchedule.whitelists?.pubkeys?.includes(event.pubkey) &&
      !feeSchedule.whitelists?.event_kinds?.some(isEventKindOrRangeMatch(event))

    const feeSchedules = currentSettings.payments?.feeSchedules?.admission?.filter(isApplicableFee)
    if (!Array.isArray(feeSchedules) || !feeSchedules.length) {
      return
    }

    const cacheKey = `${event.pubkey}:is-admitted`

    try {
      const cachedValue = await this.cache.getKey(cacheKey)
      if (cachedValue === CacheAdmissionState.ADMITTED) {
        logger('cache hit for %s admission: admitted', event.pubkey)
        return
      }
      if (cachedValue === CacheAdmissionState.BLOCKED_NOT_ADMITTED) {
        logger('cache hit for %s admission: blocked', event.pubkey)
        return 'blocked: pubkey not admitted'
      }
      if (cachedValue === CacheAdmissionState.BLOCKED_INSUFFICIENT_BALANCE) {
        logger('cache hit for %s admission: insufficient balance', event.pubkey)
        return 'blocked: insufficient balance'
      }
    } catch (error) {
      logger('cache error for %s: %o', event.pubkey, error)
    }

    const user = await this.userRepository.findByPubkey(event.pubkey)
    if (!user || !user.isAdmitted) {
      this.cacheSet(cacheKey, CacheAdmissionState.BLOCKED_NOT_ADMITTED, 60)
      return 'blocked: pubkey not admitted'
    }

    const minBalance = currentSettings.limits?.event?.pubkey?.minBalance ?? 0n
    if (minBalance > 0n && user.balance < minBalance) {
      this.cacheSet(cacheKey, CacheAdmissionState.BLOCKED_INSUFFICIENT_BALANCE, 60)
      return 'blocked: insufficient balance'
    }

    this.cacheSet(cacheKey, CacheAdmissionState.ADMITTED, 300)
  }

  private cacheSet(key: string, value: string, ttl: number): void {
    this.cache.setKey(key, value, ttl).catch((error) => logger('unable to cache %s: %o', key, error))
  }

  protected addExpirationMetadata(event: Event): Event | ExpiringEvent {
    const eventExpiration: number = getEventExpiration(event)
    if (!eventExpiration) {
      return event
    }

    const expiringEvent: ExpiringEvent = {
      ...event,
      [EventExpirationTimeMetadataKey]: eventExpiration,
    }

    return expiringEvent
  }

  protected async checkNip05Verification(event: Event): Promise<string | undefined> {
    const nip05Settings = this.settings().nip05
    if (!nip05Settings || nip05Settings.mode !== 'enabled') {
      return
    }

    if (this.getRelayPublicKey() === event.pubkey) {
      return
    }

    if (event.kind === EventKinds.SET_METADATA) {
      return
    }

    const verification = await this.nip05VerificationRepository.findByPubkey(event.pubkey)

    if (!verification) {
      return 'blocked: NIP-05 verification required'
    }

    if (!isDomainAllowed(verification.domain, nip05Settings.domainWhitelist, nip05Settings.domainBlacklist)) {
      return 'blocked: NIP-05 domain not allowed'
    }

    // `lastVerifiedAt` is the single source of truth for "currently allowed".
    // A transient network error during background re-verification leaves this
    // value intact, so a verified author keeps publishing until the configured
    // expiration elapses. Only a definitive mismatch (handled in the maintenance
    // worker / processNip05Metadata) nulls this field and blocks the author.
    //
    // Historical rows could theoretically have `isVerified=true` with a null
    // `lastVerifiedAt`; treat that as "needs re-verification" rather than
    // "verified forever".
    if (!verification.lastVerifiedAt) {
      return 'blocked: NIP-05 verification required'
    }

    const expirationMs = nip05Settings.verifyExpiration ?? DEFAULT_NIP05_VERIFY_EXPIRATION_MS
    const elapsed = Date.now() - verification.lastVerifiedAt.getTime()
    if (elapsed > expirationMs) {
      return 'blocked: NIP-05 verification expired'
    }
  }

  protected processNip05Metadata(event: Event): void {
    const nip05Settings = this.settings().nip05
    if (!nip05Settings || nip05Settings.mode === 'disabled') {
      return
    }

    if (event.kind !== EventKinds.SET_METADATA) {
      return
    }

    const nip05Identifier = extractNip05FromEvent(event)
    if (!nip05Identifier) {
      this.nip05VerificationRepository.deleteByPubkey(event.pubkey).catch((error) => {
        logger('failed to remove NIP-05 verification for %s: %o', event.pubkey, error)
      })
      return
    }

    const parsed = parseNip05Identifier(nip05Identifier)
    if (!parsed) {
      return
    }

    if (!isDomainAllowed(parsed.domain, nip05Settings.domainWhitelist, nip05Settings.domainBlacklist)) {
      logger('NIP-05 domain %s not allowed for %s', parsed.domain, event.pubkey)
      return
    }

    const repo = this.nip05VerificationRepository
    Promise.all([repo.findByPubkey(event.pubkey), verifyNip05Identifier(nip05Identifier, event.pubkey)])
      .then(([existing, outcome]) => {
        const verification = buildMetadataVerification(event.pubkey, nip05Identifier, parsed.domain, existing, outcome)
        return repo.upsert(verification)
      })
      .catch((error) => {
        logger('NIP-05 verification failed for %s: %o', event.pubkey, error)
      })
  }
}

/**
 * Build the row to upsert after a kind-0 verification attempt.
 *
 * - `verified` resets failureCount and refreshes lastVerifiedAt.
 * - `mismatch` / `invalid` are definitive: flip to unverified, null out
 *   lastVerifiedAt (the author is no longer the domain's owner), and bump
 *   failureCount relative to any prior row.
 * - `error` is transient: keep the prior isVerified/lastVerifiedAt (if any)
 *   so previously-verified authors aren't blocked by a single network hiccup,
 *   but still bump failureCount + lastCheckedAt so the re-verification backoff
 *   can take effect.
 */
function buildMetadataVerification(
  pubkey: string,
  nip05: string,
  domain: string,
  existing: Nip05Verification | undefined,
  outcome: Nip05VerificationOutcome,
): Nip05Verification {
  const now = new Date()
  const priorFailureCount = existing?.failureCount ?? 0
  const createdAt = existing?.createdAt ?? now

  switch (outcome.status) {
    case 'verified':
      return {
        pubkey,
        nip05,
        domain,
        isVerified: true,
        lastVerifiedAt: now,
        lastCheckedAt: now,
        failureCount: 0,
        createdAt,
        updatedAt: now,
      }
    case 'mismatch':
    case 'invalid':
      return {
        pubkey,
        nip05,
        domain,
        isVerified: false,
        lastVerifiedAt: null,
        lastCheckedAt: now,
        failureCount: priorFailureCount + 1,
        createdAt,
        updatedAt: now,
      }
    case 'error':
    default:
      return {
        pubkey,
        nip05,
        domain,
        isVerified: existing?.isVerified ?? false,
        lastVerifiedAt: existing?.lastVerifiedAt ?? null,
        lastCheckedAt: now,
        failureCount: priorFailureCount + 1,
        createdAt,
        updatedAt: now,
      }
  }
}
