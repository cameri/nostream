import { anyPass, equals, map, uniqWith } from 'ramda'
import { pipeline } from 'stream/promises'

import { createEndOfStoredEventsNoticeMessage, createNoticeMessage, createOutgoingEventMessage } from '../utils/messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { isEventMatchingFilter, toNostrEvent } from '../utils/event'
import { streamEach, streamEnd, streamFilter, streamMap } from '../utils/stream'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { Event } from '../@types/event'
import { IEventRepository } from '../@types/repositories'
import { IWebSocketAdapter } from '../@types/adapters'
import { Settings } from '../utils/settings'
import { SubscribeMessage } from '../@types/messages'
import { WebSocketAdapterEvent } from '../constants/adapter'

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
    const filters = uniqWith(equals, message.slice(2)) as SubscriptionFilter[]

    const reason = this.canSubscribe(subscriptionId, filters)
    if (reason) {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createNoticeMessage(`Subscription request rejected: ${reason}`))
      return
    }

    this.webSocket.emit(WebSocketAdapterEvent.Subscribe, subscriptionId, new Set(filters))

    const sendEvent = (event: Event) =>
      this.webSocket.emit(WebSocketAdapterEvent.Message, createOutgoingEventMessage(subscriptionId, event))
    const sendEOSE = () =>
      this.webSocket.emit(WebSocketAdapterEvent.Message, createEndOfStoredEventsNoticeMessage(subscriptionId))

    const findEvents = this.eventRepository.findByFilters(filters).stream()
    try {
      await pipeline(
        findEvents,
        streamMap(toNostrEvent),
        streamFilter(anyPass(map(isEventMatchingFilter)(filters))),
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

  private canSubscribe(subscriptionId: string, filters: SubscriptionFilter[]): string | undefined {
    const maxSubscriptions = Settings.limits.client.subscription.maxSubscriptions
    if (maxSubscriptions > 0) {
      const subscriptions = this.webSocket.getSubscriptions()
      if (!subscriptions.has(subscriptionId) && subscriptions.size + 1 > maxSubscriptions) {
        return `Too many subscriptions: Number of subscriptions must be less than ${maxSubscriptions}`
      }
    }

    const maxFilters = Settings.limits.client.subscription.maxFilters
    if (maxFilters > 0) {
      if (filters.length > maxFilters) {
        return `Too many filters: Number of filters per susbscription must be less or equal to ${maxFilters}`
      }
    }
  }
}
