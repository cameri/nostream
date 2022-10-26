import { EventEmitter } from 'node:stream'
import { SubscriptionFilter } from './subscription'

export interface IWebSocketServerAdapter extends EventEmitter, IWebServerAdapter {
  getConnectedClients(): number
  close(callback: () => void): void
}

export interface IWebServerAdapter extends EventEmitter {
  listen(port: number): void
}


export type IWebSocketAdapter = EventEmitter & {
  getSubscriptions(): Map<string, SubscriptionFilter[]>
}
