import { EventEmitter } from 'node:stream'
import { INegentropySessions } from './negentropy'
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
  getChallenge(): string
  getAuthenticatedPubkeys(): ReadonlySet<string>
  /** Returns false if this AUTH event id was already accepted on this socket. */
  addAuthenticatedPubkey(pubkey: string, authEventId: string): boolean
  /**
   * Configured peering peer proven by NIP-42 AUTH on this socket, or undefined.
   * Clears with the AUTH session, so an expired/closed session cannot keep peer
   * treatment.
   */
  getPeerPubkey(): string | undefined
  /** Mark `pubkey` as the peer identity for this socket. Ignored if it is not authenticated. */
  setPeerPubkey(pubkey: string): void
  /**
   * Resolves once the previous send has flushed to the underlying socket, or
   * immediately when there is nothing pending. Used to pause a full-feed read
   * while the client is slow.
   */
  waitForWritable(): Promise<void>
  drainAndClose(reason?: string): void
  /** NIP-77 sessions of this connection. */
  getNegentropySessions(): INegentropySessions
  /** Removes a subscription and aborts any in-flight read still serving it. */
  endSubscription(subscriptionId: string): void
  /**
   * Schedules a paid-access expiry check for this subscription. The adapter owns
   * the timer and clears it on CLOSE, socket close and subscription ID reuse.
   * `check` returns the next period end when access continues, `null` when access
   * is free and no longer expires, or `false` when the subscription should close.
   */
  setSubscriptionExpiry(subscriptionId: string, periodEnd: Date, check: () => Promise<Date | null | false>): void
}

export interface ICacheAdapter {
  getKey(key: string): Promise<string>
  hasKey(key: string): Promise<boolean>
  setKey(key: string, value: string, expirySeconds?: number): Promise<boolean>
  setKeyIfNotExists(key: string, value: string, expirySeconds?: number): Promise<boolean>
  addToSortedSet(key: string, set: Record<string, string> | Record<string, string>[]): Promise<number>
  removeRangeByScoreFromSortedSet(key: string, min: number, max: number): Promise<number>
  removeRangeByRankFromSortedSet(key: string, start: number, stop: number): Promise<number>
  getRangeFromSortedSet(key: string, start: number, stop: number): Promise<string[]>
  setKeyExpiry(key: string, expiry: number): Promise<void>

  deleteKey(key: string): Promise<number>
  getHKey(key: string, field: string): Promise<string>
  setHKey(key: string, fields: Record<string, string>): Promise<boolean>

  addToSet(key: string, members: string[]): Promise<number>
  getSetMembers(key: string): Promise<string[]>

  eval(script: string, keys: string[], args: string[]): Promise<unknown>
}
