import { EventKindsRange, EventRateLimit, ISettings } from '../@types/settings'
import { getEventProofOfWork, getPubkeyProofOfWork, isEventIdValid, isEventSignatureValid } from '../utils/event'
import { IEventStrategy, IMessageHandler } from '../@types/message-handlers'
import { createCommandResult } from '../utils/messages'
import { createLogger } from '../factories/logger-factory'
import { Event } from '../@types/event'
import { EventKinds } from '../constants/base'
import { Factory } from '../@types/base'
import { IncomingEventMessage } from '../@types/messages'
import { IRateLimiter } from '../@types/utils'
import { IWebSocketAdapter } from '../@types/adapters'
import { WebSocketAdapterEvent } from '../constants/adapter'

const debug = createLogger('event-message-handler')

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    protected readonly webSocket: IWebSocketAdapter,
    protected readonly strategyFactory: Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]>,
    private readonly settings: () => ISettings,
    private readonly slidingWindowRateLimiter: Factory<IRateLimiter>,
  ) { }

  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    debug('received message: %o', message)
    const [, event] = message

    let reason = await this.isEventValid(event)
    if (reason) {
      debug('event %s rejected: %s', event.id, reason)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, reason))
      return
    }

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

    const strategy = this.strategyFactory([event, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'error: event not supported'))
      return
    }

    try {
      await strategy.execute(event)
    } catch (error) {
      debug('error handling message %o: %o', message, error)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(event.id, false, 'error: unable to process event'))
    }
  }

  protected canAcceptEvent(event: Event): string | undefined {
    const now = Math.floor(Date.now()/1000)
    const limits = this.settings().limits.event
    if (limits.createdAt.maxPositiveDelta > 0 && event.created_at > now + limits.createdAt.maxPositiveDelta) {
      return `rejected: created_at is more than ${limits.createdAt.maxPositiveDelta} seconds in the future`
    }

    if (limits.createdAt.maxNegativeDelta > 0 && event.created_at < now - limits.createdAt.maxNegativeDelta) {
      return `rejected: created_at is more than ${limits.createdAt.maxNegativeDelta} seconds in the past`
    }

    if (limits.eventId.minLeadingZeroBits > 0) {
      const pow = getEventProofOfWork(event.id)
      if (pow < limits.eventId.minLeadingZeroBits) {
        return `pow: difficulty ${pow}<${limits.eventId.minLeadingZeroBits}`
      }
    }

    if (limits.pubkey.minLeadingZeroBits > 0) {
      const pow = getPubkeyProofOfWork(event.pubkey)
      if (pow < limits.pubkey.minLeadingZeroBits) {
        return `pow: pubkey difficulty ${pow}<${limits.pubkey.minLeadingZeroBits}`
      }
    }

    if (
      limits.pubkey.whitelist.length > 0
      && !limits.pubkey.whitelist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      return 'blocked: pubkey not allowed'
    }

    if (
      limits.pubkey.blacklist.length > 0
      && limits.pubkey.blacklist.some((prefix) => event.pubkey.startsWith(prefix))
    ) {
      return 'blocked: pubkey not allowed'
    }

    const isEventKindMatch = (item: EventKinds | EventKindsRange) =>
      typeof item === 'number'
      ? item === event.kind
      : event.kind >= item[0] && event.kind <= item[1]

    if (limits.kind.whitelist.length > 0 && !limits.kind.whitelist.some(isEventKindMatch)) {
      return `blocked: event kind ${event.kind} not allowed`
    }

    if (limits.kind.blacklist.length > 0 && limits.kind.blacklist.some(isEventKindMatch)) {
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
    const rateLimits = this.settings().limits?.event?.rateLimits
    if (!rateLimits || !rateLimits.length) {
      return
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

    const hits = await Promise.all(rateLimits.map(hit))

    debug('rate limit check %s: %o', event.pubkey, hits)

    return hits.some((active) => active)
  }
}
