import { EventDelegatorMetadataKey, EventTags } from '../constants/base'
import { getEventProofOfWork, getPubkeyProofOfWork, isDelegatedEvent, isDelegatedEventValid, isEventIdValid, isEventSignatureValid } from '../utils/event'
import { IEventStrategy, IMessageHandler } from '../@types/message-handlers'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { IncomingEventMessage } from '../@types/messages'
import { IWebSocketAdapter } from '../@types/adapters'
import { Settings } from '../utils/settings'
import { WebSocketAdapterEvent } from '../constants/adapter'

export class EventMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly strategyFactory: Factory<IEventStrategy<Event, Promise<void>>, [Event, IWebSocketAdapter]>
  ) { }

  public async handleMessage(message: IncomingEventMessage): Promise<void> {
    const [, event] = message

    const reason = this.canAcceptEvent(event)
    if (reason) {
      this.webSocket.emit(WebSocketAdapterEvent.Message, `Event rejected: ${reason}`)
      console.error(`Event ${event.id} rejected. Reason: ${reason}`)
      return
    }

    console.log('Received event:', event)
    if (!await isEventSignatureValid(event) || !isEventIdValid(event)) {
      console.warn(`Event ${event.id} from ${event.pubkey} with signature ${event.sig} is not valid`)
      return
    }

    if (isDelegatedEvent(event)) {
      if (await isDelegatedEventValid(event)) {
        const [, delegator] = event.tags.find((tag) => tag.length === 4 && tag[0] === EventTags.Delegation)
        event[EventDelegatorMetadataKey] = delegator
      } else {
        console.warn(`Delegated event ${event.id} from ${event.pubkey} is not valid`)
        return
      }
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

  private canAcceptEvent(event: Event): string | undefined {
    const now = Math.floor(Date.now()/1000)
    const limits = Settings.limits.event
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

    if (limits.pubkey.blacklist.length > 0) {
      if (limits.pubkey.blacklist.includes(event.pubkey)) {
        return `pubkey ${event.pubkey} is not allowed`
      }
    }

    if (limits.pubkey.whitelist.length > 0) {
      if (!limits.pubkey.whitelist.includes(event.pubkey)) {
        return `pubkey ${event.pubkey} is not allowed`
      }
    }

    if (limits.kind.blacklist.length > 0) {
      if (limits.kind.blacklist.includes(event.kind)) {
        return `event kind ${event.kind} is not allowed`
      }
    }

    if (limits.kind.whitelist.length > 0) {
      if (!limits.kind.whitelist.includes(event.kind)) {
        return `event kind ${event.kind} is not allowed`
      }
    }
  }
}
