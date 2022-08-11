import { EventEmitter } from 'node:stream'
import { WebSocket } from 'ws'
import { Event } from './event'
import { SubscriptionFilter, SubscriptionId } from './subscription'

export interface IWebSocketServerAdapter {
  getSubscriptions(client: WebSocket): Map<SubscriptionId, SubscriptionFilter[]> | undefined
  broadcastEvent(event: Event): Promise<void>
}

export interface IWebServerAdapter extends EventEmitter {
  listen(port: number)
}
