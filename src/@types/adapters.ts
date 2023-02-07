import { EventEmitter } from 'node:stream'
import { SubscriptionFilter } from './subscription'

export interface IWebSocketServerAdapter extends EventEmitter, IWebServerAdapter {
  getConnectedClients(): number
  close(callback?: () => void): void
}

export interface IWebServerAdapter extends EventEmitter {
  listen(port: number): void
  close(callback?: () => void): void
}


export type IWebSocketAdapter = EventEmitter & {
  getClientId(): string
  getClientAddress(): string
  getSubscriptions(): Map<string, SubscriptionFilter[]>
  getClientAuthChallengeData?(): { challenge: string, createdAt: Date },
  setClientToAuthenticated?()
}

export interface ICacheAdapter {
  getKey(key: string): Promise<string>
  hasKey(key: string): Promise<boolean>
  setKey(key: string, value: string): Promise<boolean>
  addToSortedSet(key: string, set: Record<string, string> | Record<string, string>[]): Promise<number>
  removeRangeByScoreFromSortedSet(key: string, min: number, max: number): Promise<number>
  getRangeFromSortedSet(key: string, start: number, stop: number): Promise<string[]>
  setKeyExpiry(key: string, expiry: number): Promise<void>
}
