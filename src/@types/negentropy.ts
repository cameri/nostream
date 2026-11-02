import { Negentropy } from '../utils/negentropy'
import { SubscriptionFilter, SubscriptionId } from './subscription'

/** Proves a caller still owns a subscription id after awaiting; see `INegentropySessions.reserve`. */
export type NegentropySessionToken = symbol

export interface NegentropySession {
  negentropy: Negentropy
  /** The filter the session was opened with, so access can be re-checked on every message. */
  filter: SubscriptionFilter
}

export interface INegentropySessions {
  /**
   * Claims `subscriptionId` for a new session, closing any session already open under that id.
   * Returns undefined when the connection already holds `maxLimit` other sessions, or already has
   * `maxLimit` event reads in flight -- including reads of requests that have since been replaced,
   * which keep running until `endRead` is called. The caller must call `endRead` for a token it got.
   */
  reserve(subscriptionId: SubscriptionId, maxLimit: number): NegentropySessionToken | undefined
  /** Marks the event read started for a reservation as finished, successfully or not. */
  endRead(token: NegentropySessionToken): void
  /** Whether `token` is still the reservation for `subscriptionId`, i.e. nobody replaced or closed it. */
  isCurrent(subscriptionId: SubscriptionId, token: NegentropySessionToken): boolean
  /**
   * Turns a reservation into a live session. Returns false when the reservation was closed or
   * replaced while the caller was busy (e.g. reading events), in which case nothing is stored.
   */
  activate(
    subscriptionId: SubscriptionId,
    token: NegentropySessionToken,
    session: NegentropySession,
    idleTimeoutMs: number,
  ): boolean
  /** The live session for an id, with its idle timer restarted. */
  touch(subscriptionId: SubscriptionId): NegentropySession | undefined
  /** Drops a reservation that never became a session; a no-op if it has since been replaced. */
  release(subscriptionId: SubscriptionId, token: NegentropySessionToken): void
  close(subscriptionId: SubscriptionId): boolean
  closeAll(): void
  getSessionIds(): SubscriptionId[]
}
