import { pipeline } from 'node:stream/promises'
import { inspect } from 'util'
import { WebSocket } from 'ws'

import { createOutgoingEventMessage, createEndOfStoredEventsNoticeMessage } from '../messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { SubscribeMessage } from '../@types/messages'
import { IWebSocketServerAdapter } from '../@types/servers'
import { IEventRepository } from '../@types/repositories'
import { SubscriptionId, SubscriptionFilter } from '../@types/subscription'
import { toNostrEvent } from '../utils/event'
import { streamEach, streamMap } from '../utils/transforms'
import { Event } from '../@types/event'


export class SubscribeMessageHandler implements IMessageHandler, IAbortable {
  private readonly abortController: AbortController

  public constructor(
    private readonly adapter: IWebSocketServerAdapter,
    private readonly eventRepository: IEventRepository,
  ) {
    this.abortController = new AbortController()
  }

  public abort(): void {
    this.abortController.abort()
  }

  public async handleMessage(message: SubscribeMessage, client: WebSocket): Promise<void> {
    const subscriptionId = message[1] as SubscriptionId
    const filters = message.slice(2) as SubscriptionFilter[]

    const exists = this.adapter.getSubscriptions(client)?.get(subscriptionId)

    this.adapter.getSubscriptions(client)?.set(subscriptionId, filters)

    console.log(
      `Subscription ${subscriptionId} ${exists ? 'updated' : 'created'
      } with filters:`,
      inspect(filters)
    )

    const sendEvent = (event: Event) => client.send(JSON.stringify(createOutgoingEventMessage(subscriptionId, event)))
    const sendEOSE = () => client.send(JSON.stringify(createEndOfStoredEventsNoticeMessage(subscriptionId)))

    const findEvents = this.eventRepository.findByfilters(filters)
    try {
      await pipeline(
        findEvents,
        streamMap(toNostrEvent),
        streamEach(
          sendEvent,
          sendEOSE, // NIP-15: End of Stored Events Notice
        ),
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
