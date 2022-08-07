import { WebSocket } from 'ws'
import { Event } from './event'
import { IMessageHandler } from './message-handlers'
import { SubscriptionFilter, SubscriptionId } from './subscription'

export interface IWebSocketServerAdapter {
  addMessageHandler(messageHandler: IMessageHandler): void
  getSubscriptions(client: WebSocket): Map<SubscriptionId, SubscriptionFilter[]> | undefined
  broadcastEvent(event: Event): Promise<void>
}

export interface IWebServerAdapter {
  listen(port: number)
}