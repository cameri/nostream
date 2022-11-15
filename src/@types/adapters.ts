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
  getClientId(): string
  getSubscriptions(): Map<string, SubscriptionFilter[]>
}

export interface ICacheAdapter {
  addToSortedSet(key: string, set: Record<string, string> | Record<string, string>[]): Promise<number>
  removeRangeByScoreFromSortedSet(key: string, min: number, max: number): Promise<number>
  getRangeFromSortedSet(key: string, start: number, stop: number): Promise<string[]>
  setKeyExpiry(key: string, expiry: number): Promise<void>
}
