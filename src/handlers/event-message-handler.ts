import { EventKindsRange, ISettings } from '../@types/settings'
import { getEventProofOfWork, getPubkeyProofOfWork, isEventIdValid, isEventSignatureValid } from '../utils/event'
import { IEventStrategy, IMessageHandler } from '../@types/message-handlers'
import { createNoticeMessage } from '../utils/messages'
import { Event } from '../@types/event'
import { EventKinds } from '../constants/base'
import { Factory } from '../@types/base'
import { IncomingEventMessage } from '../@types/messages'
import { IWebSocketAdapter } from '../@types/adapters'
import { WebSocketAdapterEvent } from '../constants/adapter'

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    protected readonly webSocket: IWebSocketAdapter,
    protected readonly strategyFactory: Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]>,
    private readonly settings: () => ISettings
  ) { }

  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    const [, event] = message

    console.debug('Received event', event)

    let reason = await this.isEventValid(event)
    if (reason) {
      console.warn(`Event ${event.id} rejected. Reason: ${reason}`)
      return
    }

    reason = this.canAcceptEvent(event)
    if (reason) {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createNoticeMessage(`Event rejected: ${reason}`))
      console.warn(`Event ${event.id} rejected. Reason: ${reason}`)
      return
    }

    const strategy = this.strategyFactory([event, this.webSocket])

    if (typeof strategy?.execute !== 'function') {
      return
    }

    try {
      await strategy.execute(event)
    } catch (error) {
      console.error('Error handling message:', message, error)
    }
  }

  protected canAcceptEvent(event: Event): string | undefined {
    const now = Math.floor(Date.now()/1000)
    const limits = this.settings().limits.event
    if (limits.createdAt.maxPositiveDelta > 0) {
      if (event.created_at > now + limits.createdAt.maxPositiveDelta) {
        return `created_at is more than ${limits.createdAt.maxPositiveDelta} seconds in the future`
      }
    }

    if (limits.createdAt.maxNegativeDelta > 0) {
      if (event.created_at < now - limits.createdAt.maxNegativeDelta) {
        return `created_at is more than ${limits.createdAt.maxNegativeDelta} seconds in the past`
      }
    }

    if (limits.eventId.minLeadingZeroBits > 0) {
      if (getEventProofOfWork(event) < limits.eventId.minLeadingZeroBits) {
        return `insufficient proof of work: event Id has less than ${limits.eventId.minLeadingZeroBits} leading zero bits`
      }
    }

    if (limits.pubkey.minLeadingZeroBits > 0) {
      if (getPubkeyProofOfWork(event.pubkey) < limits.pubkey.minLeadingZeroBits) {
        return `insufficient proof of work: pubkey has less than ${limits.pubkey.minLeadingZeroBits} leading zero bits`
      }
    }

    if (limits.pubkey.whitelist.length > 0) {
      if (!limits.pubkey.whitelist.some((prefix) => event.pubkey.startsWith(prefix))) {
        return `pubkey ${event.pubkey} is not allowed`
      }
    }

    if (limits.pubkey.blacklist.length > 0) {
      if (limits.pubkey.blacklist.some((prefix) => event.pubkey.startsWith(prefix))) {
        return `pubkey ${event.pubkey} is not allowed`
      }
    }

    const isEventKindMatch = (item: EventKinds | EventKindsRange) =>
      typeof item === 'number'
      ? item === event.kind
      : event.kind >= item[0] && event.kind <= item[1]

    if (limits.kind.whitelist.length > 0) {
      if (!limits.kind.whitelist.some(isEventKindMatch)) {
        return `event kind ${event.kind} is not allowed`
      }
    }

    if (limits.kind.blacklist.length > 0) {
      if (limits.kind.blacklist.some(isEventKindMatch)) {
        return `event kind ${event.kind} is not allowed`
      }
    }
  }

  protected async isEventValid(event: Event): Promise<string | undefined> {
    if (!await isEventIdValid(event)) {
      return `Event with id ${event.id} from ${event.pubkey} is not valid`
    }
    if (!await isEventSignatureValid(event)) {
      return `Event with id ${event.id} from ${event.pubkey} has invalid signature`
    }
  }
}
