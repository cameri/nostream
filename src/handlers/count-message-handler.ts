import { equals, uniqWith } from 'ramda'

import { IWebSocketAdapter } from '../@types/adapters'
import { IMessageHandler } from '../@types/message-handlers'
import { CountMessage } from '../@types/messages'
import { IEventRepository } from '../@types/repositories'
import { Settings } from '../@types/settings'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { WebSocketAdapterEvent } from '../constants/adapter'
import { createLogger } from '../factories/logger-factory'
import { createClosedMessage, createCountResultMessage } from '../utils/messages'

const debug = createLogger('count-message-handler')

export class CountMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings,
  ) {}

  public async handleMessage(message: CountMessage): Promise<void> {
    const queryId = message[1]
    const countEnabled = this.settings().nip45?.enabled ?? true
    if (!countEnabled) {
      this.webSocket.emit(WebSocketAdapterEvent.Message, createClosedMessage(queryId, 'COUNT is disabled by relay configuration'))
      return
    }

    // Some clients send the same filter more than once.
    // We remove duplicates so we do less DB work.
    const filters = uniqWith(equals, message.slice(2)) as SubscriptionFilter[]

    const reason = this.canCount(queryId, filters)
    if (reason) {
      debug('count request %s with %o rejected: %s', queryId, filters, reason)
      // NIP-45 says we should close rejected COUNT requests with a reason.
      this.webSocket.emit(WebSocketAdapterEvent.Message, createClosedMessage(queryId, reason))
      return
    }

    try {
      const count = await this.eventRepository.countByFilters(filters)
      this.webSocket.emit(WebSocketAdapterEvent.Message, createCountResultMessage(queryId, { count }))
    } catch (error) {
      debug('count request %s failed: %o', queryId, error)
      // Keep this message generic so internal errors are not leaked to clients.
      this.webSocket.emit(WebSocketAdapterEvent.Message, createClosedMessage(queryId, 'error: unable to count events'))
    }
  }

  private canCount(queryId: SubscriptionId, filters: SubscriptionFilter[]): string | undefined {
    const subscriptionLimits = this.settings().limits?.client?.subscription
    const maxFilters = subscriptionLimits?.maxFilters ?? 0

    if (maxFilters > 0 && filters.length > maxFilters) {
      return `Too many filters: Number of filters per count query must be less than or equal to ${maxFilters}`
    }

    if (
      typeof subscriptionLimits?.maxSubscriptionIdLength === 'number' &&
      queryId.length > subscriptionLimits.maxSubscriptionIdLength
    ) {
      return `Query ID too long: Query ID must be less than or equal to ${subscriptionLimits.maxSubscriptionIdLength}`
    }
  }
}
