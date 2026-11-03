import { FSWatcher } from 'fs'
import { z } from 'zod'
import { ICacheAdapter } from '../@types/adapters'
import { IRunnable } from '../@types/base'
import { Event } from '../@types/event'
import { PeeringPeerSyncState } from '../@types/peering'
import { IEventRepository, IUserRepository } from '../@types/repositories'
import { PeeringPeer, PeeringScope, Settings } from '../@types/settings'
import { SubscriptionFilter } from '../@types/subscription'
import { createLogger } from '../factories/logger-factory'
import { idSchema, pubkeySchema, signatureSchema, tagSchema } from '../schemas/base-schema'
import { createEventBatchPersister } from '../services/event-import-service'
import { ADMIN_OPS_HEARTBEAT_KEEPALIVE_MS, publishAdminOpsWorkerHeartbeatSafely } from '../utils/admin-ops-store'
import {
  broadcastEvent,
  getRelayPrivateKey,
  isEphemeralEvent,
  isEventIdValid,
  isEventMatchingFilter,
  isEventSignatureValid,
  isExpiredEvent,
  isRequestToVanishEvent,
} from '../utils/event'
import { delayMs } from '../utils/misc'
import { FetchPeeringAdvertisementOptions, fetchPeeringAdvertisement } from '../utils/peering-advertisement'
import {
  AuthenticatedPeerConnection,
  authenticateToPeeringRelay,
  listEnabledPeeringPeers,
  parsePeeringPeerPubkey,
} from '../utils/peering-auth'
import { PeeringConnection, PeeringFetchOverflowError, PeeringSyncConnection } from '../utils/peering-connection'
import {
  isCurrentPeeringScope,
  peeringScopesToLiveFilters,
  peeringScopeToFilters,
  splitPeeringFilter,
} from '../utils/peering-scope'
import { PeeringSyncStateStore } from '../utils/peering-sync-state'
import { SettingsStatic } from '../utils/settings'

const logger = createLogger('peering-sync-worker')

export const PEERING_SYNC_RECONCILE_INTERVAL_MS = 15 * 60_000
export const PEERING_SYNC_RECONNECT_DELAY_MS = 5_000
export const PEERING_SYNC_EVENT_BATCH_SIZE = 500
export const PEERING_SYNC_PEER_REFRESH_MS = 30_000
export const PEERING_SYNC_STATE_HEARTBEAT_MS = 60_000
export const PEERING_SYNC_MAX_PENDING_EVENTS = 500
export const PEERING_SYNC_MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024
export const PEERING_SYNC_MAX_SCOPE_SPLIT_DEPTH = 20

const eventShapeSchema = z
  .object({
    id: idSchema,
    pubkey: pubkeySchema,
    created_at: z.number().int().nonnegative(),
    kind: z.number().int(),
    tags: z.array(tagSchema),
    content: z.string(),
    sig: signatureSchema,
  })
  .strict()

type AuthenticatePeerFn = (options: {
  relayUrl: string
  privateKey: string
  timeoutMs?: number
}) => Promise<AuthenticatedPeerConnection>

type FetchAdvertisementFn = (
  relayUrl: string,
  options?: FetchPeeringAdvertisementOptions,
) => ReturnType<typeof fetchPeeringAdvertisement>

export interface PeeringSyncWorkerOptions {
  authenticate?: AuthenticatePeerFn
  fetchAdvertisement?: FetchAdvertisementFn
  createConnection?: (socket: AuthenticatedPeerConnection['socket']) => PeeringSyncConnection
  stateStore?: PeeringSyncStateStore
  opsCache?: ICacheAdapter
  userRepository?: Pick<IUserRepository, 'isVanished' | 'setVanished'>
  privateKey?: () => string
  reconnectDelayMs?: number
  reconcileIntervalMs?: number
  peerRefreshMs?: number
  stateHeartbeatMs?: number
  eventBatchSize?: number
}

interface SessionCallbacks {
  onReconciled: (error?: Error) => void
}

const normalizePeer = (peer: PeeringPeer): PeeringPeer | undefined => {
  const pubkey = parsePeeringPeerPubkey(peer.pubkey)
  if (!pubkey || peer.enabled === false) {
    return undefined
  }

  return { ...peer, pubkey }
}

const newestCreatedAt = (items: { event_created_at: number }[]): number | undefined =>
  items.length ? items[items.length - 1]!.event_created_at : undefined

const isOversizedReconciliationError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)

  return /too big|too many events|exceeds .*events|maximum .*events/i.test(message)
}

class PeeringPeerSession {
  private stopped = false
  private connection: PeeringSyncConnection | undefined
  private reconcileTimer: NodeJS.Timeout | undefined
  private reconcileRunning = false
  private liveFilters: SubscriptionFilter[] = []
  private scopes: PeeringScope[] = []
  private state: PeeringPeerSyncState
  private stateTimer: NodeJS.Timeout | undefined
  private stateDirty = false
  private readonly pendingEvents: Event[] = []
  private pendingEventBytes = 0
  private drainingEvents = false
  private readonly persistEvents: (events: Event[]) => Promise<number>
  private stateHeartbeatTimer: NodeJS.Timeout | undefined

  public constructor(
    private readonly peer: PeeringPeer,
    private readonly settings: () => Settings,
    private readonly eventRepository: IEventRepository,
    private readonly options: Required<
      Pick<PeeringSyncWorkerOptions, 'authenticate' | 'fetchAdvertisement' | 'createConnection' | 'privateKey'>
    > &
      Pick<
        PeeringSyncWorkerOptions,
        | 'stateStore'
        | 'reconnectDelayMs'
        | 'reconcileIntervalMs'
        | 'eventBatchSize'
        | 'userRepository'
        | 'stateHeartbeatMs'
      >,
    private readonly callbacks: SessionCallbacks,
  ) {
    this.state = {
      pubkey: peer.pubkey.toLowerCase(),
      relayUrl: peer.relayUrl,
      status: 'idle',
      scopeCount: 0,
      updatedAt: new Date().toISOString(),
    }
    this.persistEvents = createEventBatchPersister(eventRepository, {
      userRepository: options.userRepository,
      relayUrl: settings().info?.relay_url,
    })
  }

  public start(): void {
    this.stateHeartbeatTimer = setInterval(
      () => this.publishStateHeartbeat(),
      this.options.stateHeartbeatMs ?? PEERING_SYNC_STATE_HEARTBEAT_MS,
    )
    this.stateHeartbeatTimer.unref()
    void this.runLoop()
  }

  public get id(): string {
    return `${this.peer.pubkey}|${this.peer.relayUrl}`
  }

  public stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true
    clearInterval(this.reconcileTimer)
    clearInterval(this.stateHeartbeatTimer)
    this.stateHeartbeatTimer = undefined
    if (this.stateTimer) {
      clearTimeout(this.stateTimer)
      this.stateTimer = undefined
    }
    this.connection?.close()
    this.connection = undefined
    this.pendingEvents.length = 0
    this.pendingEventBytes = 0
    this.queueState({ status: 'stopped' })
    void this.flushState()
  }

  private async runLoop(): Promise<void> {
    const reconnectDelayMs = this.options.reconnectDelayMs ?? PEERING_SYNC_RECONNECT_DELAY_MS

    while (!this.stopped) {
      if (!this.isStillConfigured()) {
        logger('peer %s is no longer enabled in settings; stopping its session', this.peer.relayUrl)
        return
      }

      try {
        await this.connectAndFollow()
      } catch (error) {
        if (this.stopped) {
          break
        }

        const message = error instanceof Error ? error.message : String(error)
        logger.error('peer %s sync failed: %s', this.peer.relayUrl, message)
        this.queueState({ status: 'error', lastError: message })
        this.callbacks.onReconciled(error instanceof Error ? error : new Error(message))
      } finally {
        this.connection?.close()
        this.connection = undefined
        clearInterval(this.reconcileTimer)
        this.reconcileTimer = undefined
      }

      if (!this.stopped) {
        await delayMs(reconnectDelayMs)
      }
    }
  }

  private isStillConfigured(): boolean {
    const normalized = parsePeeringPeerPubkey(this.peer.pubkey)

    return listEnabledPeeringPeers(this.settings()).some(
      (peer) => parsePeeringPeerPubkey(peer.pubkey) === normalized && peer.relayUrl === this.peer.relayUrl,
    )
  }

  private async connectAndFollow(): Promise<void> {
    this.queueState({ status: 'connecting', lastError: undefined })
    const advertisement = await this.options.fetchAdvertisement(this.peer.relayUrl)
    if (!advertisement.enabled) {
      throw new Error('peer does not advertise peering')
    }

    if (!advertisement.supportedNips.includes(77)) {
      throw new Error('peer does not advertise NIP-77')
    }

    const configuredPubkey = parsePeeringPeerPubkey(this.peer.pubkey)
    if (configuredPubkey && advertisement.self && advertisement.self !== configuredPubkey) {
      throw new Error(`peer advertises relay key ${advertisement.self} but is configured as ${configuredPubkey}`)
    }

    this.queueState({ scopeCount: advertisement.scopes.length })

    const authenticated = await this.options.authenticate({
      relayUrl: this.peer.relayUrl,
      privateKey: this.options.privateKey(),
    })

    if (this.stopped) {
      authenticated.socket.close()
      return
    }

    const connection = this.options.createConnection(authenticated.socket)
    this.connection = connection
    this.scopes = advertisement.scopes

    // Start the live feed first: a long history reconciliation can outlast the
    // overlap window, and events published after its snapshot must still be
    // delivered. Reconciliation and live writes are both duplicate-safe.
    this.liveFilters = peeringScopesToLiveFilters(advertisement.scopes, Math.floor(Date.now() / 1000))
    if (this.liveFilters.length) {
      await connection.subscribe(this.liveFilters, (event) => this.queueEvent(event))
    }

    if (this.stopped) {
      return
    }

    await this.reconcile(connection, advertisement.scopes)

    if (this.stopped) {
      return
    }

    this.queueState({ status: 'live' })
    this.startReconcileTimer(connection, advertisement.scopes)

    await connection.waitForClose()

    if (!this.stopped) {
      throw new Error('peer connection closed')
    }
  }

  private startReconcileTimer(connection: PeeringSyncConnection, scopes: PeeringScope[]): void {
    clearInterval(this.reconcileTimer)
    const intervalMs = this.options.reconcileIntervalMs ?? PEERING_SYNC_RECONCILE_INTERVAL_MS

    this.reconcileTimer = setInterval(() => {
      void this.reconcile(connection, scopes).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('periodic reconciliation with %s failed: %s', this.peer.relayUrl, message)
        this.queueState({ status: 'error', lastError: message })
        this.callbacks.onReconciled(error instanceof Error ? error : new Error(message))
      })
    }, intervalMs)
    this.reconcileTimer.unref()
  }

  private async reconcile(connection: PeeringSyncConnection, scopes: PeeringScope[]): Promise<void> {
    if (this.reconcileRunning || this.stopped) {
      return
    }

    this.reconcileRunning = true
    const startedAt = new Date().toISOString()
    const startedAtSeconds = Math.floor(Date.now() / 1000)
    this.queueState({
      status: 'reconciling',
      lastSyncStartedAt: startedAt,
    })

    try {
      const needed = new Map<string, SubscriptionFilter>()
      const currentFilters: SubscriptionFilter[] = []
      let newestCurrent: number | undefined

      for (const scope of scopes) {
        if (this.stopped) {
          return
        }

        const filters = peeringScopeToFilters(scope, startedAtSeconds)
        const countCurrent = isCurrentPeeringScope(scope, startedAtSeconds)
        if (countCurrent) {
          currentFilters.push(...filters)
        }

        for (const filter of filters) {
          newestCurrent = await this.reconcileFilter(
            connection,
            filter,
            startedAtSeconds,
            needed,
            newestCurrent,
            countCurrent,
          )
        }
      }

      const ids = [...needed.keys()]
      const batchSize = this.options.eventBatchSize ?? PEERING_SYNC_EVENT_BATCH_SIZE
      let received = 0

      for (let offset = 0; offset < ids.length; offset += batchSize) {
        if (this.stopped) {
          return
        }

        const batch = ids.slice(offset, offset + batchSize)
        const result = await this.fetchAndStoreBatch(connection, batch, needed)

        received += result.stored
        for (const event of result.events) {
          if (currentFilters.some((filter) => isEventMatchingFilter(filter)(event))) {
            newestCurrent = newestCurrent === undefined ? event.created_at : Math.max(newestCurrent, event.created_at)
          }
        }
      }

      const finishedAt = new Date().toISOString()
      const finishedAtSeconds = Math.floor(Date.now() / 1000)
      this.queueState({
        status: 'live',
        lastSyncFinishedAt: finishedAt,
        lastReconciledAt: finishedAt,
        lastError: undefined,
        missingEvents: ids.length,
        receivedEvents: received,
        ...(newestCurrent !== undefined ? { latestEventCreatedAt: newestCurrent } : {}),
        ...(newestCurrent !== undefined ? { lagSeconds: Math.max(0, finishedAtSeconds - newestCurrent) } : {}),
      })
      this.callbacks.onReconciled()
      logger(
        'reconciled %s over %d scope(s): %d missing, %d received',
        this.peer.relayUrl,
        scopes.length,
        ids.length,
        received,
      )
    } finally {
      this.reconcileRunning = false
    }
  }

  private async reconcileFilter(
    connection: PeeringSyncConnection,
    filter: SubscriptionFilter,
    nowSeconds: number,
    needed: Map<string, SubscriptionFilter>,
    newestCurrent: number | undefined,
    countCurrent: boolean,
    depth = 0,
  ): Promise<number | undefined> {
    if (this.stopped) {
      return newestCurrent
    }

    const items = await this.eventRepository.findReconciliationItems(filter)
    const newest = newestCreatedAt(items)

    if (countCurrent && newest !== undefined) {
      newestCurrent = newestCurrent === undefined ? newest : Math.max(newestCurrent, newest)
    }

    try {
      const result = await connection.reconcile(filter, items)
      for (const id of result.needIds) {
        if (!needed.has(id)) {
          needed.set(id, filter)
        }
      }

      return newestCurrent
    } catch (error) {
      if (depth >= PEERING_SYNC_MAX_SCOPE_SPLIT_DEPTH || !isOversizedReconciliationError(error)) {
        throw error
      }

      const split = splitPeeringFilter(filter, nowSeconds)
      if (!split) {
        throw error
      }

      logger.warn(
        'peer %s rejected a filter as too large; splitting it in time (depth %d)',
        this.peer.relayUrl,
        depth + 1,
      )

      let current = newestCurrent
      for (const child of split) {
        current = await this.reconcileFilter(connection, child, nowSeconds, needed, current, countCurrent, depth + 1)
      }

      return current
    }
  }

  private queueEvent(event: Event): void {
    const size = Buffer.byteLength(JSON.stringify(event))
    if (
      this.pendingEvents.length >= PEERING_SYNC_MAX_PENDING_EVENTS ||
      this.pendingEventBytes + size > PEERING_SYNC_MAX_PENDING_EVENT_BYTES
    ) {
      logger.warn('peer %s live event backlog exceeded; reconnecting', this.peer.relayUrl)
      this.connection?.close()
      return
    }

    this.pendingEvents.push(event)
    this.pendingEventBytes += size
    void this.drainEvents()
  }

  private async drainEvents(): Promise<void> {
    if (this.drainingEvents) {
      return
    }

    this.drainingEvents = true
    try {
      while (this.pendingEvents.length > 0 && !this.stopped) {
        const event = this.pendingEvents.shift() as Event
        this.pendingEventBytes = Math.max(0, this.pendingEventBytes - Buffer.byteLength(JSON.stringify(event)))

        try {
          await this.applyLiveEvent(event)
        } catch (error) {
          // One bad event must not poison the queue or become an unhandled
          // rejection; the next reconciliation can retry it.
          logger.error('failed to apply live event from %s: %o', this.peer.relayUrl, error)
        }
      }
    } finally {
      this.drainingEvents = false
    }
  }

  private async applyLiveEvent(event: Event): Promise<void> {
    const nowSeconds = Math.floor(Date.now() / 1000)
    // Persistence uses the scope's own bounds, not the subscription overlap:
    // a late publish older than 60s is still valid for a scope without a
    // rolling window.
    const currentFilters = this.scopes
      .filter((scope) => isCurrentPeeringScope(scope, nowSeconds))
      .flatMap((scope) => peeringScopeToFilters(scope, nowSeconds))

    if (!currentFilters.some((filter) => isEventMatchingFilter(filter)(event))) {
      return
    }

    await this.acceptEvents([event], undefined, true)
    const latestCreatedAt = Math.max(this.state.latestEventCreatedAt ?? 0, event.created_at)

    this.queueState({
      lastEventAt: new Date().toISOString(),
      latestEventCreatedAt: latestCreatedAt,
      lagSeconds: Math.max(0, nowSeconds - latestCreatedAt),
    })
  }

  private async fetchAndStoreBatch(
    connection: PeeringSyncConnection,
    ids: string[],
    needed: Map<string, SubscriptionFilter>,
  ): Promise<{ stored: number; events: Event[] }> {
    try {
      const events = await connection.fetchEvents(ids)
      const accepted = await this.acceptEvents(events, needed)

      return { stored: accepted.stored, events: accepted.events }
    } catch (error) {
      if (!(error instanceof PeeringFetchOverflowError)) {
        throw error
      }

      if (ids.length <= 1) {
        logger.warn(
          'peer %s sent an oversized event for %s; leaving it for the next reconciliation',
          this.peer.relayUrl,
          ids[0],
        )
        return { stored: 0, events: [] }
      }

      const midpoint = Math.ceil(ids.length / 2)
      const left = await this.fetchAndStoreBatch(connection, ids.slice(0, midpoint), needed)
      const right = await this.fetchAndStoreBatch(connection, ids.slice(midpoint), needed)

      return {
        stored: left.stored + right.stored,
        events: [...left.events, ...right.events],
      }
    }
  }

  /**
   * Accepts only events that were asked for and still match the scope, then
   * verifies the event id and signature. A peer cannot inject an arbitrary
   * event through a reconciliation reply, and a compromised transport cannot
   * alter one that the peer did sign.
   */
  private async acceptEvents(
    events: Event[],
    scopeById?: Map<string, SubscriptionFilter>,
    broadcast = false,
  ): Promise<{ events: Event[]; stored: number }> {
    const accepted: Event[] = []

    for (const event of events) {
      if (scopeById && !scopeById.has(event.id)) {
        continue
      }

      if (!eventShapeSchema.safeParse(event).success) {
        continue
      }

      const scopeFilter = scopeById?.get(event.id)
      if (scopeFilter && !isEventMatchingFilter(scopeFilter)(event)) {
        continue
      }

      if (isExpiredEvent(event)) {
        continue
      }

      if (!(await isEventIdValid(event)) || !(await isEventSignatureValid(event))) {
        logger.warn('peer %s sent an event with an invalid id or signature: %s', this.peer.relayUrl, event.id)
        continue
      }

      accepted.push(event)
    }

    if (accepted.length === 0) {
      return { events: [], stored: 0 }
    }

    let stored = 0

    if (broadcast) {
      // Live traffic is one event at a time, so we can tell which write
      // actually stored or changed something. Only those are rebroadcast:
      // an overlap replay of an event both relays already hold must not echo.
      for (const event of accepted) {
        const count = await this.persistEvents([event])
        stored += count

        if ((count > 0 || isEphemeralEvent(event)) && !isRequestToVanishEvent(event)) {
          void broadcastEvent(event).catch((error) => {
            logger.error('failed to broadcast synced event %s: %o', event.id, error)
          })
        }
      }

      return { events: accepted, stored }
    }

    // Backfill is deliberately not broadcast: those events predate any live
    // subscription and a full sync must not fan out a dump.
    stored = await this.persistEvents(accepted)

    return { events: accepted, stored }
  }

  private queueState(partial: Partial<PeeringPeerSyncState>): void {
    if (this.stopped && partial.status !== 'stopped') {
      return
    }

    this.state = {
      ...this.state,
      ...partial,
      updatedAt: new Date().toISOString(),
    }
    this.stateDirty = true

    if (this.stateTimer) {
      return
    }

    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined
      void this.flushState()
    }, 250)
    this.stateTimer.unref()
  }

  private async flushState(): Promise<void> {
    if (!this.options.stateStore || !this.stateDirty) {
      return
    }

    this.stateDirty = false
    try {
      await this.options.stateStore.publish(this.state)
    } catch (error) {
      logger.warn('failed to record sync state for %s: %o', this.peer.relayUrl, error)
    }
  }

  /** Keeps a long reconciliation from looking stale in the admin console. */
  private publishStateHeartbeat(): void {
    if (this.stopped || !this.options.stateStore) {
      return
    }

    const nowSeconds = Math.floor(Date.now() / 1000)
    this.state = {
      ...this.state,
      updatedAt: new Date().toISOString(),
      ...(this.state.latestEventCreatedAt !== undefined
        ? { lagSeconds: Math.max(0, nowSeconds - this.state.latestEventCreatedAt) }
        : {}),
    }
    this.stateDirty = true
    void this.flushState()
  }
}

export class PeeringSyncWorker implements IRunnable {
  private sessions = new Map<string, PeeringPeerSession>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private peerRefreshTimer: NodeJS.Timeout | undefined
  private watchers: FSWatcher[] | undefined
  private lastRunFinishedAt: string | undefined
  private lastError: string | undefined
  private readonly startedAt = new Date().toISOString()

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly settings: () => Settings,
    private readonly eventRepository: IEventRepository,
    private readonly options: PeeringSyncWorkerOptions = {},
  ) {
    this.process
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  public run(): void {
    this.watchers = SettingsStatic.watchSettings()
    this.applyConfiguredPeers()

    this.publishHeartbeat()
    this.heartbeatTimer = setInterval(() => this.publishHeartbeat(), ADMIN_OPS_HEARTBEAT_KEEPALIVE_MS)
    this.heartbeatTimer.unref()

    // `watchSettings` invalidates the cached settings document; this periodic
    // pass also replaces a session when only its relay URL changed, which a
    // pubkey-only configuration check would miss.
    this.peerRefreshTimer = setInterval(
      () => this.applyConfiguredPeers(),
      this.options.peerRefreshMs ?? PEERING_SYNC_PEER_REFRESH_MS,
    )
    this.peerRefreshTimer.unref()
  }

  private sessionKey(peer: PeeringPeer): string {
    return `${parsePeeringPeerPubkey(peer.pubkey) ?? peer.pubkey}|${peer.relayUrl}`
  }

  private applyConfiguredPeers(): void {
    const peers = listEnabledPeeringPeers(this.settings())
      .map(normalizePeer)
      .filter((peer): peer is PeeringPeer => peer !== undefined)
    const desired = new Map(peers.map((peer) => [this.sessionKey(peer), peer]))

    for (const [id, session] of this.sessions) {
      if (!desired.has(id)) {
        logger('stopping sync with removed or changed peer %s', session.id)
        session.stop()
        this.sessions.delete(id)
      }
    }

    const commonOptions = {
      authenticate: this.options.authenticate ?? authenticateToPeeringRelay,
      fetchAdvertisement: this.options.fetchAdvertisement ?? fetchPeeringAdvertisement,
      createConnection: this.options.createConnection ?? ((socket) => new PeeringConnection(socket)),
      privateKey: this.options.privateKey ?? (() => getRelayPrivateKey(this.settings().info?.relay_url)),
      stateStore: this.options.stateStore,
      userRepository: this.options.userRepository,
      reconnectDelayMs: this.options.reconnectDelayMs,
      reconcileIntervalMs: this.options.reconcileIntervalMs,
      eventBatchSize: this.options.eventBatchSize,
      stateHeartbeatMs: this.options.stateHeartbeatMs,
    }

    for (const [id, peer] of desired) {
      if (this.sessions.has(id)) {
        continue
      }

      const session = new PeeringPeerSession(peer, this.settings, this.eventRepository, commonOptions, {
        onReconciled: (error) => {
          if (error) {
            this.lastError = error.message
            return
          }
          this.lastRunFinishedAt = new Date().toISOString()
          this.lastError = undefined
        },
      })

      logger('starting sync with peer %s', peer.relayUrl)
      this.sessions.set(id, session)
      session.start()
    }

    if (this.sessions.size === 0) {
      logger('no enabled peering peers configured; worker idle')
    }
  }

  private publishHeartbeat(): void {
    void publishAdminOpsWorkerHeartbeatSafely(this.options.opsCache, {
      type: 'peering-sync',
      updatedAt: new Date().toISOString(),
      lastRunStartedAt: this.startedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastError: this.lastError,
    })
  }

  private onError(error: Error): void {
    logger('error: %o', error)
    this.lastError = error.message
  }

  private onExit(): void {
    logger('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void): void {
    logger('closing')
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    clearInterval(this.peerRefreshTimer)
    this.peerRefreshTimer = undefined
    if (Array.isArray(this.watchers)) {
      for (const watcher of this.watchers) {
        watcher.close()
      }
    }
    this.watchers = undefined
    for (const session of this.sessions.values()) {
      session.stop()
    }
    this.sessions.clear()
    callback?.()
  }
}
