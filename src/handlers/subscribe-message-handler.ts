import { pipeline } from 'stream/promises'

import { createOutgoingEventMessage, createEndOfStoredEventsNoticeMessage } from '../messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { SubscribeMessage } from '../@types/messages'
import { IWebSocketAdapter } from '../@types/adapters'
import { IEventRepository } from '../@types/repositories'
import { SubscriptionId, SubscriptionFilter } from '../@types/subscription'
import { toNostrEvent } from '../utils/event'
import { streamEach, streamEnd, streamMap } from '../utils/stream'
import { Event } from '../@types/event'


export class SubscribeMessageHandler implements IMessageHandler, IAbortable {
  private readonly abortController: AbortController

  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
  ) {
    this.abortController = new AbortController()
  }

  public abort(): void {
    this.abortController.abort()
  }

  public async handleMessage(message: SubscribeMessage): Promise<void> {
    const subscriptionId = message[1] as SubscriptionId
    const filters = message.slice(2) as SubscriptionFilter[]

    this.webSocket.emit('subscribe', subscriptionId, new Set(filters))

    const sendEvent = (event: Event) => this.webSocket.sendMessage(createOutgoingEventMessage(subscriptionId, event))
    const sendEOSE = () => this.webSocket.sendMessage(createEndOfStoredEventsNoticeMessage(subscriptionId))

    const findEvents = this.eventRepository.findByfilters(filters)
    try {
      await pipeline(
        findEvents,
        streamMap(toNostrEvent),
        streamEach(sendEvent),
        streamEnd(sendEOSE), // NIP-15: End of Stored Events Notice
        {
          signal: this.abortController.signal,
        },
      )
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('AbortError when finding events')
        findEvents.end()
      }
      throw error
    }
  }

}
