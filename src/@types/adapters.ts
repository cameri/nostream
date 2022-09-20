import { EventEmitter } from 'node:stream'
import { SubscriptionFilter } from './subscription'

export interface IWebSocketServerAdapter extends EventEmitter {
  getConnectedClients(): number
  terminate(): Promise<void>
}

export interface IWebServerAdapter extends EventEmitter {
  listen(port: number)
}


export type IWebSocketAdapter = EventEmitter & {
  getSubscriptions(): Map<string, Set<SubscriptionFilter>>
}
