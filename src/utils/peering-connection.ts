import WebSocket, { RawData } from 'ws'

import { Event } from '../@types/event'
import { ReconciliationItem } from '../@types/repositories'
import { SubscriptionFilter } from '../@types/subscription'
import { createLogger } from '../factories/logger-factory'
import { Negentropy, NegentropyStorageVector, ReconcileResult } from './negentropy'
import { NEGENTROPY_FRAME_SIZE_LIMIT } from './nip77'

const logger = createLogger('peering-connection')

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Upper bound for one fetched id batch's EVENT payloads, independent of count. */
export const PEERING_FETCH_MAX_BYTES = 8 * 1024 * 1024

export interface PeeringSyncConnection {
  /** Reconciles one filter against the peer, returning the ids each side lacks. */
  reconcile(filter: SubscriptionFilter, items: ReconciliationItem[], timeoutMs?: number): Promise<ReconcileResult>
  /** Fetches specific event ids over an ordinary REQ; resolves after EOSE. */
  fetchEvents(ids: string[], timeoutMs?: number, maxBytes?: number): Promise<Event[]>
  /** Opens a long-lived REQ and resolves after its EOSE. Events keep arriving afterwards. */
  subscribe(filters: SubscriptionFilter[], onEvent: (event: Event) => void, timeoutMs?: number): Promise<void>
  /** Resolves when the socket closes, cleanly or not. */
  waitForClose(): Promise<void>
  close(): void
}

interface NegWaiter {
  resolve: (payload: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface RequestState {
  onEvent: (event: Event) => void
  resolve?: () => void
  reject?: (error: Error) => void
  timer?: NodeJS.Timeout
  closed: boolean
  /** A live feed must end the connection on CLOSED so the worker reconnects. */
  persistent?: boolean
  /** Only ids still in this set are accepted; deletion makes fetches duplicate-safe. */
  expectedIds?: Set<string>
  receivedBytes?: number
  maxBytes?: number
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

const messageType = (message: unknown[]): string => (typeof message[0] === 'string' ? message[0] : '')

const requestId = (message: unknown[]): string | undefined => (typeof message[1] === 'string' ? message[1] : undefined)

const parseMessage = (raw: RawData): unknown[] | undefined => {
  try {
    const parsed = JSON.parse(raw.toString())

    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * One authenticated outbound peering socket, speaking only the wire primitives
 * the relay already implements for clients: AUTH (done before construction),
 * NEG-OPEN/NEG-MSG/NEG-CLOSE for history and REQ/EVENT/EOSE for the live feed.
 */
export class PeeringConnection implements PeeringSyncConnection {
  private readonly negWaiters = new Map<string, NegWaiter>()
  private readonly requests = new Map<string, RequestState>()
  private readonly closePromise: Promise<void>
  private closed = false
  private requestCounter = 0

  public constructor(private readonly socket: WebSocket) {
    this.closePromise = new Promise<void>((resolve) => {
      socket.once('close', () => {
        this.closed = true
        this.failAll(new Error('peering connection closed'))
        resolve()
      })
    })

    socket.on('message', this.onMessage.bind(this))
    socket.on('error', (error) => {
      logger('peer socket error: %o', error)
    })
  }

  public async reconcile(
    filter: SubscriptionFilter,
    items: ReconciliationItem[],
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ReconcileResult> {
    const subscriptionId = this.nextRequestId('neg')
    const storage = new NegentropyStorageVector()

    for (const item of items) {
      storage.insert(item.event_created_at, item.event_id)
    }
    storage.seal()

    const negentropy = new Negentropy(storage, NEGENTROPY_FRAME_SIZE_LIMIT)
    const haveIds: string[] = []
    const needIds: string[] = []

    let output: Uint8Array | null = negentropy.initiate()
    let waiting = this.waitForNegMsg(subscriptionId, timeoutMs)

    try {
      this.send(['NEG-OPEN', subscriptionId, filter, toHex(output)])

      while (output !== null) {
        const payload = await waiting

        const result = negentropy.reconcile(Buffer.from(payload, 'hex'))
        haveIds.push(...result.haveIds)
        needIds.push(...result.needIds)
        output = result.output

        if (output !== null) {
          waiting = this.waitForNegMsg(subscriptionId, timeoutMs)
          this.send(['NEG-MSG', subscriptionId, toHex(output)])
        }
      }
    } finally {
      this.clearNegWaiter(subscriptionId)
      if (!this.closed) {
        try {
          this.send(['NEG-CLOSE', subscriptionId])
        } catch {
          // The socket may have closed while the final message was in flight.
        }
      }
    }

    return { output: null, haveIds, needIds }
  }

  public async fetchEvents(
    ids: string[],
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxBytes = PEERING_FETCH_MAX_BYTES,
  ): Promise<Event[]> {
    if (ids.length === 0) {
      return []
    }

    const subscriptionId = this.nextRequestId('fetch')
    const events: Event[] = []

    try {
      await this.openSubscription(subscriptionId, [{ ids }], (event) => events.push(event), timeoutMs, false, {
        expectedIds: new Set(ids),
        maxBytes,
      })

      return events
    } finally {
      this.closeSubscription(subscriptionId)
    }
  }

  public subscribe(
    filters: SubscriptionFilter[],
    onEvent: (event: Event) => void,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const subscriptionId = this.nextRequestId('live')

    return this.openSubscription(subscriptionId, filters, onEvent, timeoutMs, true)
  }
  public waitForClose(): Promise<void> {
    return this.closePromise
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    this.failAll(new Error('peering connection closed'))
    try {
      this.socket.close()
    } catch {
      // Already closing; the close event will settle the promise.
    }
  }

  private openSubscription(
    subscriptionId: string,
    filters: SubscriptionFilter[],
    onEvent: (event: Event) => void,
    timeoutMs: number,
    persistent = false,
    bounds: Pick<RequestState, 'expectedIds' | 'maxBytes'> = {},
  ): Promise<void> {
    const state: RequestState = {
      onEvent,
      closed: false,
      persistent,
      ...bounds,
    }

    this.requests.set(subscriptionId, state)

    return new Promise<void>((resolve, reject) => {
      state.resolve = resolve
      state.reject = reject
      state.timer = setTimeout(() => {
        if (state.closed) {
          return
        }
        state.closed = true
        this.requests.delete(subscriptionId)
        reject(new Error('timed out waiting for the peer to finish the stored query'))
      }, timeoutMs)
      state.timer.unref()

      try {
        this.send(['REQ', subscriptionId, ...filters])
      } catch (error) {
        this.clearRequest(state)
        this.requests.delete(subscriptionId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private closeSubscription(subscriptionId: string): void {
    const state = this.requests.get(subscriptionId)
    if (state) {
      this.clearRequest(state)
      this.requests.delete(subscriptionId)
    }

    if (!this.closed) {
      try {
        this.send(['CLOSE', subscriptionId])
      } catch {
        // The socket may already be closing.
      }
    }
  }

  private waitForNegMsg(subscriptionId: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.negWaiters.delete(subscriptionId)
        reject(new Error('timed out waiting for a negentropy reply'))
      }, timeoutMs)
      timer.unref()

      this.negWaiters.set(subscriptionId, { resolve, reject, timer })
    })
  }

  private clearNegWaiter(subscriptionId: string): void {
    const waiter = this.negWaiters.get(subscriptionId)
    if (!waiter) {
      return
    }

    clearTimeout(waiter.timer)
    this.negWaiters.delete(subscriptionId)
  }

  private onMessage(raw: RawData): void {
    const message = parseMessage(raw)
    if (!message) {
      return
    }

    const subscriptionId = requestId(message)
    if (!subscriptionId) {
      return
    }

    switch (messageType(message)) {
      case 'NEG-MSG': {
        const waiter = this.negWaiters.get(subscriptionId)
        if (!waiter || typeof message[2] !== 'string') {
          return
        }
        clearTimeout(waiter.timer)
        this.negWaiters.delete(subscriptionId)
        waiter.resolve(message[2])
        return
      }
      case 'NEG-ERR': {
        const waiter = this.negWaiters.get(subscriptionId)
        if (!waiter) {
          return
        }
        clearTimeout(waiter.timer)
        this.negWaiters.delete(subscriptionId)
        waiter.reject(new Error(typeof message[2] === 'string' ? message[2] : 'negentropy request rejected'))
        return
      }
      case 'EVENT': {
        const state = this.requests.get(subscriptionId)
        const event = message[2]
        if (!state || typeof event !== 'object' || event === null) {
          return
        }

        const parsedEvent = event as Event
        if (state.expectedIds && !state.expectedIds.delete(parsedEvent.id)) {
          return
        }

        const size = Buffer.byteLength(JSON.stringify(parsedEvent))
        state.receivedBytes = (state.receivedBytes ?? 0) + size
        if (state.maxBytes !== undefined && state.receivedBytes > state.maxBytes) {
          this.clearRequest(state)
          this.requests.delete(subscriptionId)
          state.reject?.(new Error('peer sent more event data than this request allows'))
          this.close()
          return
        }

        state.onEvent(parsedEvent)
        return
      }
      case 'EOSE': {
        const state = this.requests.get(subscriptionId)
        if (!state) {
          return
        }
        if (state.timer) {
          clearTimeout(state.timer)
        }
        state.resolve?.()
        return
      }
      case 'CLOSED': {
        const state = this.requests.get(subscriptionId)
        if (!state) {
          return
        }
        const reason = typeof message[2] === 'string' ? message[2] : 'peer closed the subscription'
        this.clearRequest(state)
        this.requests.delete(subscriptionId)
        state.reject?.(new Error(reason))
        if (state.persistent) {
          logger.warn('peer closed the live subscription: %s', reason)
          this.close()
        }
        return
      }
      default:
        return
    }
  }

  private clearRequest(state: RequestState): void {
    state.closed = true
    if (state.timer) {
      clearTimeout(state.timer)
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.negWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.negWaiters.clear()

    for (const state of this.requests.values()) {
      this.clearRequest(state)
      state.reject?.(error)
    }
    this.requests.clear()
  }

  private send(message: unknown[]): void {
    if (this.closed) {
      throw new Error('peering connection is closed')
    }

    this.socket.send(JSON.stringify(message))
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1

    return `peering-${prefix}-${this.requestCounter}`
  }
}
