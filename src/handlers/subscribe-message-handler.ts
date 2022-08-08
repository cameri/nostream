import { inspect } from 'util'
import { WebSocket } from 'ws'

import { createOutgoingEventMessage, createEndOfStoredEventsNoticeMessage } from '../messages'
import { IMessageHandler } from '../types/message-handlers'
import { MessageType, SubscribeMessage } from '../types/messages'
import { IWebSocketServerAdapter } from '../types/servers'
import { IEventRepository } from '../types/repositories'
import { SubscriptionId, SubscriptionFilter } from '../types/subscription'


export class SubscribeMessageHandler implements IMessageHandler {
  public constructor(
    private readonly eventRepository: IEventRepository,
  ) { }

  public canHandleMessageType(messageType: MessageType): boolean {
    return messageType === MessageType.REQ
  }

  public async handleMessage(message: SubscribeMessage, client: WebSocket, adapter: IWebSocketServerAdapter): Promise<boolean> {
    const subscriptionId = message[1] as SubscriptionId
    const filters = message.slice(2) as SubscriptionFilter[]

    const exists = adapter.getSubscriptions(client)?.get(subscriptionId)

    adapter.getSubscriptions(client)?.set(subscriptionId, filters)

    console.log(
      `Subscription ${subscriptionId} ${exists ? 'updated' : 'created'
      } with filters:`,
      inspect(filters)
    )

    // TODO: search for matching events on the DB, then send ESOE

    return this.eventRepository.findByfilters(filters).then(
      (events) => {
        events.forEach((event) => {
          client.send(
            JSON.stringify(
              createOutgoingEventMessage(subscriptionId, event)
            )
          )
        })
        console.debug(`Sent ${events.length} events to:`, subscriptionId)
        client.send(
          JSON.stringify(
            createEndOfStoredEventsNoticeMessage(subscriptionId)
          )
        )
        console.debug('Sent EOSE to:', subscriptionId)
        return true
      },
      (error) => {
        console.error('Unable to find by filters: ', error)
        return true
      }
    )
  }

}