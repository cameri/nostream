import { Event, ExpiringEvent  } from '../@types/event'
import { EventRateLimit, FeeSchedule, Settings } from '../@types/settings'
import { getEventExpiration, getEventProofOfWork, getPubkeyProofOfWork, getPublicKey, getRelayPrivateKey, isEventIdValid, isEventKindOrRangeMatch, isEventSignatureValid, isExpiredEvent } from '../utils/event'
import { IEventStrategy, IMessageHandler } from '../@types/message-handlers'
import { ContextMetadataKey } from '../constants/base'
import { createCommandResult } from '../utils/messages'
import { createLogger } from '../factories/logger-factory'
import { EventExpirationTimeMetadataKey } from '../constants/base'
import { Factory } from '../@types/base'
import { IncomingEventMessage } from '../@types/messages'
import { IRateLimiter } from '../@types/utils'
import { IUserRepository } from '../@types/repositories'
import { IWebSocketAdapter } from '../@types/adapters'
import { WebSocketAdapterEvent } from '../constants/adapter'

const debug = createLogger('event-message-handler')

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    protected readonly webSocket: IWebSocketAdapter,
    protected readonly strategyFactory: Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]>,
    protected readonly userRepository: IUserRepository,
    private readonly settings: () => Settings,
    private readonly slidingWindowRateLimiter: Factory<IRateLimiter>,
  ) {}

  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    let [, event] = message

    event[ContextMetadataKey] = message[ContextMetadataKey]

    let reason = await this.isEventValid(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    if (isExpiredEvent(event)) {
      debug('event %s rejected: expired')
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'event is expired'))
      return
    }

    event = this.addExpirationMetadata(event)

    if (await this.isRateLimited(event)) {
      debug('event %s rejected: rate-limited')
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'rate-limited: slow down'))
      return
    }

    reason = this.canAcceptEvent(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    reason = await this.isUserAdmitted(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

    const strategy = this.strategyFactory([event, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'error: event not supported'))
      return
    }

    try {
      await strategy.execute(event)
    } catch (error) {
      console.error('error handling message', message, error)
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
    const now = Math.floor(Date.now()/1000)

    const limits = this.settings().limits?.event ?? {}

    if (Array.isArray(limits.content)) {
      for (const limit of limits.content) {
        if (
          typeof limit.maxLength !== 'undefined'
          && limit.maxLength > 0
          && event.content.length > limit.maxLength
          && (
            !Array.isArray(limit.kinds)
            || limit.kinds.some(isEventKindOrRangeMatch(event))
          )
        ) {
          return `rejected: content is longer than ${limit.maxLength} bytes`
        }
      }
    } else if (
      typeof limits.content?.maxLength !== 'undefined'
      && limits.content?.maxLength > 0
      && event.content.length > limits.content.maxLength
      && (
        !Array.isArray(limits.content.kinds)
        || limits.content.kinds.some(isEventKindOrRangeMatch(event))
      )
    ) {
      return `rejected: content is longer than ${limits.content.maxLength} bytes`
    }

    if (
      typeof limits.createdAt?.maxPositiveDelta !== 'undefined'
      && limits.createdAt.maxPositiveDelta > 0
      && event.created_at > now + limits.createdAt.maxPositiveDelta) {
      return `rejected: created_at is more than ${limits.createdAt.maxPositiveDelta} seconds in the future`
    }

    if (
      typeof limits.createdAt?.maxNegativeDelta !== 'undefined'
      && limits.createdAt.maxNegativeDelta > 0
      && event.created_at < now - limits.createdAt.maxNegativeDelta) {
      return `rejected: created_at is more than ${limits.createdAt.maxNegativeDelta} seconds in the past`
    }

    if (
      typeof limits.eventId?.minLeadingZeroBits !== 'undefined'
      && limits.eventId.minLeadingZeroBits > 0
    ) {
      const pow = getEventProofOfWork(event.id)
      if (pow < limits.eventId.minLeadingZeroBits) {
        return `pow: difficulty ${pow}<${limits.eventId.minLeadingZeroBits}`
      }
    }

    if (
      typeof limits.pubkey?.minLeadingZeroBits !== 'undefined'
      && limits.pubkey.minLeadingZeroBits > 0
    ) {
      const pow = getPubkeyProofOfWork(event.pubkey)
      if (pow < limits.pubkey.minLeadingZeroBits) {
        return `pow: pubkey difficulty ${pow}<${limits.pubkey.minLeadingZeroBits}`
      }
    }

    if (
      typeof limits.pubkey?.whitelist !== 'undefined'
      && limits.pubkey.whitelist.length > 0
      && !limits.pubkey.whitelist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      return 'blocked: pubkey not allowed'
    }

    if (
      typeof limits.pubkey?.blacklist !== 'undefined'
      && limits.pubkey.blacklist.length > 0
      && limits.pubkey.blacklist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      return 'blocked: pubkey not allowed'
    }

    if (
      typeof limits.kind?.whitelist !== 'undefined'
      && limits.kind.whitelist.length > 0
      && !limits.kind.whitelist.some(isEventKindOrRangeMatch(event))) {
      return `blocked: event kind ${event.kind} not allowed`
    }

    if (
      typeof limits.kind?.blacklist !== 'undefined'
      && limits.kind.blacklist.length > 0
      && limits.kind.blacklist.some(isEventKindOrRangeMatch(event))) {
      return `blocked: event kind ${event.kind} not allowed`
    }
  }

  protected async isEventValid(event: Event): Promise<string | undefined> {
    if (!await isEventIdValid(event)) {
      return 'invalid: event id does not match'
    }
    if (!await isEventSignatureValid(event)) {
      return 'invalid: event signature verification failed'
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
      typeof whitelists?.pubkeys !== 'undefined'
      && Array.isArray(whitelists?.pubkeys)
      && whitelists.pubkeys.includes(event.pubkey)
    ) {
      return false
    }

    if (
      typeof whitelists?.ipAddresses !== 'undefined'
      && Array.isArray(whitelists?.ipAddresses)
      && whitelists.ipAddresses.includes(this.webSocket.getClientAddress())
    ) {
      return false
    }

    const rateLimiter = this.slidingWindowRateLimiter()

    const toString = (input: any | any[]): string => {
      return Array.isArray(input) ? `[${input.map(toString)}]` : input.toString()
    }

    const hit = ({ period, rate, kinds = undefined }: EventRateLimit) => {
      const key = Array.isArray(kinds)
        ? `${event.pubkey}:events:${period}:${toString(kinds)}`
        : `${event.pubkey}:events:${period}`

      return rateLimiter.hit(
        key,
        1,
        { period, rate },
      )
    }

    let limited = false
    for (const { rate, period, kinds } of rateLimits) {
      // skip if event kind does not apply
      if (Array.isArray(kinds) && !kinds.some(isEventKindOrRangeMatch(event))) {
        continue
      }

      const isRateLimited = await hit({ period, rate, kinds })

      if (isRateLimited) {
        debug('rate limited %s: %d events / %d ms exceeded', event.pubkey, rate, period)

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
      feeSchedule.enabled
      && !feeSchedule.whitelists?.pubkeys?.some((prefix) => event.pubkey.startsWith(prefix))
      && !feeSchedule.whitelists?.event_kinds?.some(isEventKindOrRangeMatch(event))

    const feeSchedules = currentSettings.payments?.feeSchedules?.admission?.filter(isApplicableFee)
    if (!Array.isArray(feeSchedules) || !feeSchedules.length) {
      return
    }

    // const hasKey = await this.cache.hasKey(`${event.pubkey}:is-admitted`)
    // TODO: use cache
    const user = await this.userRepository.findByPubkey(event.pubkey)
    if (!user || !user.isAdmitted) {
      return 'blocked: pubkey not admitted'
    }

    const minBalance = currentSettings.limits?.event?.pubkey?.minBalance ?? 0n
    if (minBalance > 0n && user.balance < minBalance) {
      return 'blocked: insufficient balance'
    }
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
}
