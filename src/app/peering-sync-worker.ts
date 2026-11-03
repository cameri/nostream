import { z } from 'zod'
import { ICacheAdapter } from '../@types/adapters'
import { IRunnable } from '../@types/base'
import { Event, ExpiringEvent } from '../@types/event'
import { PeeringPeerSyncState } from '../@types/peering'
import { IEventRepository } from '../@types/repositories'
import { PeeringPeer, PeeringScope, Settings } from '../@types/settings'
import { SubscriptionFilter } from '../@types/subscription'
import { EventExpirationTimeMetadataKey } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { idSchema, pubkeySchema, signatureSchema, tagSchema } from '../schemas/base-schema'
import { ADMIN_OPS_HEARTBEAT_KEEPALIVE_MS, publishAdminOpsWorkerHeartbeatSafely } from '../utils/admin-ops-store'
import {
  broadcastEvent,
  getEventExpiration,
  getRelayPrivateKey,
  isEventIdValid,
  isEventMatchingFilter,
  isEventSignatureValid,
  isExpiredEvent,
} from '../utils/event'
import { delayMs } from '../utils/misc'
import { FetchPeeringAdvertisementOptions, fetchPeeringAdvertisement } from '../utils/peering-advertisement'
import {
  AuthenticatedPeerConnection,
  authenticateToPeeringRelay,
  listEnabledPeeringPeers,
  parsePeeringPeerPubkey,
} from '../utils/peering-auth'
import { PeeringConnection, PeeringSyncConnection } from '../utils/peering-connection'
import { isCurrentPeeringScope, peeringScopesToLiveFilters, peeringScopeToFilter } from '../utils/peering-scope'
import { PeeringSyncStateStore } from '../utils/peering-sync-state'

const logger = createLogger('peering-sync-worker')

export const PEERING_SYNC_RECONCILE_INTERVAL_MS = 15 * 60_000
export const PEERING_SYNC_RECONNECT_DELAY_MS = 5_000
export const PEERING_SYNC_EVENT_BATCH_SIZE = 500

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
  privateKey?: () => string
  reconnectDelayMs?: number
  reconcileIntervalMs?: number
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

class PeeringPeerSession {
  private stopped = false
  private connection: PeeringSyncConnection | undefined
  private reconcileTimer: NodeJS.Timeout | undefined
  private reconcileRunning = false
  private liveFilters: SubscriptionFilter[] = []
  private state: PeeringPeerSyncState
  private stateTimer: NodeJS.Timeout | undefined
  private stateDirty = false
  private eventChain: Promise<void> = Promise.resolve()

  public constructor(
    private readonly peer: PeeringPeer,
    private readonly settings: () => Settings,
    private readonly eventRepository: IEventRepository,
    private readonly options: Required<
      Pick<PeeringSyncWorkerOptions, 'authenticate' | 'fetchAdvertisement' | 'createConnection' | 'privateKey'>
    > &
      Pick<PeeringSyncWorkerOptions, 'stateStore' | 'reconnectDelayMs' | 'reconcileIntervalMs' | 'eventBatchSize'>,
    private readonly callbacks: SessionCallbacks,
  ) {
    this.state = {
      pubkey: peer.pubkey.toLowerCase(),
      relayUrl: peer.relayUrl,
      status: 'idle',
      scopeCount: 0,
      updatedAt: new Date().toISOString(),
    }
  }

  public start(): void {
    void this.runLoop()
  }

  public stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true
    clearInterval(this.reconcileTimer)
    if (this.stateTimer) {
      clearTimeout(this.stateTimer)
      this.stateTimer = undefined
    }
    this.connection?.close()
    this.connection = undefined
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

    return listEnabledPeeringPeers(this.settings()).some((peer) => parsePeeringPeerPubkey(peer.pubkey) === normalized)
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

    await this.reconcile(connection, advertisement.scopes)

    if (this.stopped) {
      return
    }

    this.liveFilters = peeringScopesToLiveFilters(advertisement.scopes, Math.floor(Date.now() / 1000))
    if (this.liveFilters.length) {
      await connection.subscribe(this.liveFilters, (event) => this.queueEvent(event))
    }

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
        logger.error('periodic reconciliation with %s failed: %o', this.peer.relayUrl, error)
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
      lastError: undefined,
    })

    try {
      const needed = new Map<string, SubscriptionFilter>()
      const currentFilters: SubscriptionFilter[] = []
      let newestCurrent: number | undefined

      for (const scope of scopes) {
        if (this.stopped) {
          return
        }

        const filter = peeringScopeToFilter(scope, startedAtSeconds)
        const items = await this.eventRepository.findReconciliationItems(filter)
        const newest = newestCreatedAt(items)

        if (isCurrentPeeringScope(scope, startedAtSeconds)) {
          currentFilters.push(filter)
          if (newest !== undefined) {
            newestCurrent = newestCurrent === undefined ? newest : Math.max(newestCurrent, newest)
          }
        }

        const result = await connection.reconcile(filter, items)
        for (const id of result.needIds) {
          if (!needed.has(id)) {
            needed.set(id, filter)
          }
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
        const events = await connection.fetchEvents(batch)
        const accepted = await this.acceptEvents(events, needed)

        received += accepted.length
        for (const event of accepted) {
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

  private queueEvent(event: Event): void {
    this.eventChain = this.eventChain
      .then(async () => {
        if (this.stopped) {
          return
        }

        if (!this.liveFilters.some((filter) => isEventMatchingFilter(filter)(event))) {
          return
        }

        await this.acceptEvents([event], undefined, true)
        this.queueState({
          lastEventAt: new Date().toISOString(),
          latestEventCreatedAt: event.created_at,
          lagSeconds: Math.max(0, Math.floor(Date.now() / 1000) - event.created_at),
        })
      })
      .catch((error) => {
        logger.error('failed to apply live event from %s: %o', this.peer.relayUrl, error)
      })
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
  ): Promise<Event[]> {
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

      const expiration = getEventExpiration(event)
      accepted.push(expiration ? ({ ...event, [EventExpirationTimeMetadataKey]: expiration } as ExpiringEvent) : event)
    }

    if (accepted.length === 0) {
      return accepted
    }

    await this.eventRepository.upsertMany(accepted)

    // Backfill is deliberately not broadcast: those events predate any live
    // subscription and a full sync must not fan out a dump. Live events are
    // new to this relay, so local subscribers see them like local publishes.
    if (!broadcast) {
      return accepted
    }

    for (const event of accepted) {
      void broadcastEvent(event).catch((error) => {
        logger.error('failed to broadcast synced event %s: %o', event.id, error)
      })
    }

    return accepted
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
}

export class PeeringSyncWorker implements IRunnable {
  private sessions: PeeringPeerSession[] = []
  private heartbeatTimer: NodeJS.Timeout | undefined
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
    const peers = listEnabledPeeringPeers(this.settings())
      .map(normalizePeer)
      .filter((peer): peer is PeeringPeer => peer !== undefined)

    if (peers.length === 0) {
      logger('no enabled peering peers configured; worker idle')
      return
    }

    const commonOptions = {
      authenticate: this.options.authenticate ?? authenticateToPeeringRelay,
      fetchAdvertisement: this.options.fetchAdvertisement ?? fetchPeeringAdvertisement,
      createConnection: this.options.createConnection ?? ((socket) => new PeeringConnection(socket)),
      privateKey: this.options.privateKey ?? (() => getRelayPrivateKey(this.settings().info?.relay_url)),
      stateStore: this.options.stateStore,
      reconnectDelayMs: this.options.reconnectDelayMs,
      reconcileIntervalMs: this.options.reconcileIntervalMs,
      eventBatchSize: this.options.eventBatchSize,
    }

    this.sessions = peers.map(
      (peer) =>
        new PeeringPeerSession(peer, this.settings, this.eventRepository, commonOptions, {
          onReconciled: (error) => {
            if (error) {
              this.lastError = error.message
              return
            }
            this.lastRunFinishedAt = new Date().toISOString()
            this.lastError = undefined
          },
        }),
    )

    logger('starting sync with %d peering peer(s)', this.sessions.length)
    for (const session of this.sessions) {
      session.start()
    }

    this.publishHeartbeat()
    this.heartbeatTimer = setInterval(() => this.publishHeartbeat(), ADMIN_OPS_HEARTBEAT_KEEPALIVE_MS)
    this.heartbeatTimer.unref()
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
    for (const session of this.sessions) {
      session.stop()
    }
    this.sessions = []
    callback?.()
  }
}
