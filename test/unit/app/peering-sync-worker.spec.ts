import { expect } from 'chai'
import EventEmitter from 'events'
import { Event } from '../../../src/@types/event'
import { PeeringPeerSyncState } from '../../../src/@types/peering'
import { IEventRepository, ReconciliationItem } from '../../../src/@types/repositories'
import { Settings } from '../../../src/@types/settings'
import { PeeringSyncWorker } from '../../../src/app/peering-sync-worker'
import { getPublicKey, identifyEvent, isEventMatchingFilter, signEvent } from '../../../src/utils/event'
import { PeeringFetchOverflowError } from '../../../src/utils/peering-connection'
import { PeeringSyncStateStore } from '../../../src/utils/peering-sync-state'

const privateKey = 'a'.repeat(64)
const pubkey = getPublicKey(privateKey)
const peerPubkey = getPublicKey('b'.repeat(64))

const makeEvent = async (content: string, createdAt: number): Promise<Event> => {
  const unsigned = await identifyEvent({
    pubkey,
    created_at: createdAt,
    kind: 1,
    tags: [],
    content,
  })

  return signEvent(privateKey)(unsigned)
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class FakeConnection {
  public liveOnEvent?: (event: Event) => void
  public closeCalls = 0
  private readonly closed: Promise<void>
  private resolveClosed: (() => void) | undefined

  public constructor(private readonly remoteEvents: Event[]) {
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
  }

  public async reconcile(
    filter: Parameters<typeof isEventMatchingFilter>[0],
    items: ReconciliationItem[],
  ): Promise<{ output: null; haveIds: string[]; needIds: string[] }> {
    const localIds = new Set(items.map((item) => Buffer.from(item.event_id).toString('hex')))
    const remoteIds = this.remoteEvents.filter((event) => isEventMatchingFilter(filter)(event)).map((event) => event.id)

    return {
      output: null,
      haveIds: [],
      needIds: remoteIds.filter((id) => !localIds.has(id)),
    }
  }

  public async fetchEvents(ids: string[]): Promise<Event[]> {
    const wanted = new Set(ids)

    return this.remoteEvents.filter((event) => wanted.has(event.id))
  }

  public async subscribe(_filters: unknown[], onEvent: (event: Event) => void): Promise<void> {
    this.liveOnEvent = onEvent
  }

  public waitForClose(): Promise<void> {
    return this.closed
  }

  public close(): void {
    this.closeCalls += 1
    this.resolveClosed?.()
  }
}

class FakeStateStore extends PeeringSyncStateStore {
  public readonly published: PeeringPeerSyncState[] = []

  public constructor() {
    super({} as any)
  }

  public override async publish(state: PeeringPeerSyncState): Promise<void> {
    this.published.push({ ...state })
  }
}

describe('PeeringSyncWorker', () => {
  const now = Math.floor(Date.now() / 1000)
  let fakeProcess: EventEmitter & { exit: (...args: unknown[]) => void }
  let connection: FakeConnection
  let stateStore: FakeStateStore
  let localEvents: Event[]
  let eventRepository: IEventRepository
  let worker: PeeringSyncWorker
  let settingsState: Settings

  beforeEach(async () => {
    fakeProcess = Object.assign(new EventEmitter(), {
      exit: () => {},
    })
    localEvents = []
    stateStore = new FakeStateStore()
    settingsState = {
      info: { relay_url: 'wss://relay.example.com' },
      peering: {
        enabled: true,
        peers: [{ pubkey: peerPubkey, relayUrl: 'wss://peer.example.com', enabled: true }],
      },
    } as Settings

    eventRepository = {
      findReconciliationItems: async (filter: Parameters<typeof isEventMatchingFilter>[0]) =>
        localEvents
          .filter((event) => isEventMatchingFilter(filter)(event))
          .map((event) => ({ event_created_at: event.created_at, event_id: Buffer.from(event.id, 'hex') })),
      create: async (event: Event) => {
        if (localEvents.some((local) => local.id === event.id)) {
          return 0
        }
        localEvents.push(event)
        return 1
      },
      createMany: async (events: Event[]) => {
        let inserted = 0
        for (const event of events) {
          if (!localEvents.some((local) => local.id === event.id)) {
            localEvents.push(event)
            inserted += 1
          }
        }
        return inserted
      },
      upsert: async (event: Event) => {
        const index = localEvents.findIndex((local) => local.id === event.id)
        if (index >= 0) {
          if (localEvents[index].created_at < event.created_at) {
            localEvents[index] = event
            return 1
          }
          return 0
        }
        localEvents.push(event)
        return 1
      },
      upsertMany: async (events: Event[]) => {
        let inserted = 0
        for (const event of events) {
          if (!localEvents.some((local) => local.id === event.id)) {
            localEvents.push(event)
            inserted += 1
          }
        }
        return inserted
      },
      deleteByPubkeyAndIds: async (pubkey: string, ids: string[]) => {
        const before = localEvents.length
        const remaining = localEvents.filter((event) => !(event.pubkey === pubkey && ids.includes(event.id)))
        localEvents.splice(0, localEvents.length, ...remaining)
        return before - localEvents.length
      },
      deleteByPubkeyExceptKinds: async (pubkey: string, excludedKinds: number[]) => {
        const before = localEvents.length
        const remaining = localEvents.filter((event) => event.pubkey !== pubkey || excludedKinds.includes(event.kind))
        localEvents.splice(0, localEvents.length, ...remaining)
        return before - localEvents.length
      },
    } as unknown as IEventRepository
  })

  afterEach(() => {
    worker?.close()
  })

  interface StartWorkerOptions {
    scopes?: { kinds: number[]; windowSeconds?: number }[]
    reconcileIntervalMs?: number
    peerRefreshMs?: number
    stateHeartbeatMs?: number
    configureConnection?: (connection: FakeConnection) => void
    userRepository?: {
      isVanished: (pubkey: string) => Promise<boolean>
      setVanished: (pubkey: string) => Promise<number>
    }
  }

  const startWorker = (remoteEvents: Event[], options: StartWorkerOptions = {}): void => {
    connection = new FakeConnection(remoteEvents)
    options.configureConnection?.(connection)

    worker = new PeeringSyncWorker(fakeProcess as unknown as NodeJS.Process, () => settingsState, eventRepository, {
      authenticate: async () => ({ socket: { close: () => {} }, challenge: 'c', authEvent: {} }) as any,
      fetchAdvertisement: async () => ({
        enabled: true,
        supportedNips: [1, 77],
        self: peerPubkey,
        terms: [],
        scopes: options.scopes ?? [{ kinds: [1] }],
      }),
      createConnection: () => connection as any,
      stateStore,
      privateKey: () => privateKey,
      reconcileIntervalMs: options.reconcileIntervalMs ?? 60_000,
      peerRefreshMs: options.peerRefreshMs,
      stateHeartbeatMs: options.stateHeartbeatMs,
      reconnectDelayMs: 10,
      userRepository: options.userRepository,
    })

    worker.run()
  }

  it('converges an empty store from negentropy and then applies live events', async () => {
    const current = Math.floor(Date.now() / 1000)
    const historical = await makeEvent('historical', current - 30)
    startWorker([historical])

    await waitFor(() => localEvents.length === 1)
    expect(localEvents[0].id).to.equal(historical.id)
    expect(connection.liveOnEvent).to.be.a('function')

    await waitFor(() => stateStore.published.some((state) => state.status === 'live'))
    const liveState = stateStore.published.filter((state) => state.status === 'live').at(-1)
    expect(liveState?.lastReconciledAt).to.be.a('string')
    expect(liveState?.missingEvents).to.equal(1)
    expect(liveState?.receivedEvents).to.equal(1)

    const live = await makeEvent('live', current)
    connection.liveOnEvent?.(live)

    await waitFor(() => localEvents.length === 2)
    expect(localEvents.map((event) => event.id)).to.include(live.id)

    const older = await makeEvent('older overlap replay', current - 20)
    connection.liveOnEvent?.(older)

    await waitFor(() => localEvents.length === 3)
    await waitFor(() => stateStore.published.at(-1)?.latestEventCreatedAt === live.created_at)
    const lag = stateStore.published.at(-1)?.lagSeconds ?? Infinity
    expect(lag).to.be.at.least(0)
    expect(lag).to.be.at.most(5)
  })

  it('delivers live events while history reconciliation is still running', async () => {
    let releaseReconcile: (() => void) | undefined
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve
    })

    startWorker([], {
      configureConnection: (fake) => {
        const reconcile = fake.reconcile.bind(fake)
        fake.reconcile = async (filter, items) => {
          await reconcileGate
          return reconcile(filter as any, items)
        }
      },
    })

    await waitFor(() => connection.liveOnEvent !== undefined)

    const live = await makeEvent('during history sync', Math.floor(Date.now() / 1000))
    connection.liveOnEvent?.(live)

    await waitFor(() => localEvents.length === 1)
    expect(localEvents[0].id).to.equal(live.id)
    releaseReconcile?.()
  })

  it('republishes sync state while a long reconciliation is running', async () => {
    let releaseReconcile: (() => void) | undefined
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve
    })

    startWorker([], {
      stateHeartbeatMs: 20,
      configureConnection: (fake) => {
        const reconcile = fake.reconcile.bind(fake)
        fake.reconcile = async (filter, items) => {
          await reconcileGate
          return reconcile(filter as any, items)
        }
      },
    })

    await waitFor(() => stateStore.published.filter((state) => state.status === 'reconciling').length >= 2)
    releaseReconcile?.()
  })

  it('advances lag on state heartbeats between reconciliations', async () => {
    const head = await makeEvent('head', Math.floor(Date.now() / 1000))
    startWorker([head], { stateHeartbeatMs: 20 })

    await waitFor(() => localEvents.length === 1)
    await waitFor(() => stateStore.published.some((state) => (state.lagSeconds ?? 0) >= 1), 4_000)
  })

  it('retries an overflowing fetch batch in smaller pieces', async () => {
    const first = await makeEvent('first', now - 30)
    const second = await makeEvent('second', now - 20)
    const fetchSizes: number[] = []

    startWorker([first, second], {
      configureConnection: (fake) => {
        const fetchEvents = fake.fetchEvents.bind(fake)
        fake.fetchEvents = async (ids) => {
          fetchSizes.push(ids.length)
          if (ids.length > 1) {
            throw new PeeringFetchOverflowError()
          }
          return fetchEvents(ids)
        }
      },
    })

    await waitFor(() => localEvents.length === 2)
    expect(fetchSizes).to.deep.equal([2, 1, 1])
  })

  it('re-checks live events against scope bounds, not the subscription overlap', async () => {
    startWorker([])

    await waitFor(() => connection.liveOnEvent !== undefined)

    const late = await makeEvent('late publish', Math.floor(Date.now() / 1000) - 120)
    connection.liveOnEvent?.(late)

    await waitFor(() => localEvents.length === 1)
    expect(localEvents[0].id).to.equal(late.id)
  })

  it('splits a scope the peer rejects as too large', async () => {
    const historical = await makeEvent('historical', now - 30)
    let calls = 0

    startWorker([historical], {
      configureConnection: (fake) => {
        const reconcile = fake.reconcile.bind(fake)
        fake.reconcile = async (filter, items) => {
          calls += 1
          if (calls === 1) {
            throw new Error('blocked: this query is too big')
          }
          return reconcile(filter as any, items)
        }
      },
    })

    await waitFor(() => localEvents.length === 1)
    expect(localEvents[0].id).to.equal(historical.id)
    expect(calls).to.be.greaterThan(2)
    await waitFor(() => stateStore.published.some((state) => state.status === 'live'))
    expect(stateStore.published.filter((state) => state.status === 'live').at(-1)?.missingEvents).to.equal(1)
  })

  it('does not count a batch whose write stored nothing', async () => {
    const historical = await makeEvent('historical', now - 30)
    eventRepository.createMany = async () => 0
    eventRepository.upsertMany = async () => 0
    eventRepository.create = async () => 0
    eventRepository.upsert = async () => 0

    startWorker([historical])

    await waitFor(() => stateStore.published.some((state) => state.status === 'live'))
    const liveState = stateStore.published.filter((state) => state.status === 'live').at(-1)
    expect(localEvents).to.have.length(0)
    expect(liveState?.receivedEvents).to.equal(0)
  })

  it('applies the rolling window to live events using the current time', async () => {
    startWorker([], { scopes: [{ kinds: [1], windowSeconds: 60 }] })

    await waitFor(() => connection.liveOnEvent !== undefined)

    const current = Math.floor(Date.now() / 1000)
    const stale = await makeEvent('outside window', current - 120)
    connection.liveOnEvent?.(stale)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(localEvents).to.have.length(0)

    const fresh = await makeEvent('inside window', current)
    connection.liveOnEvent?.(fresh)
    await waitFor(() => localEvents.length === 1)
    expect(localEvents[0].id).to.equal(fresh.id)
  })

  it('stops a session when its peer is disabled in reloaded settings', async () => {
    startWorker([], { peerRefreshMs: 20 })
    await waitFor(() => connection.liveOnEvent !== undefined)

    settingsState = {
      ...settingsState,
      peering: {
        enabled: true,
        peers: [],
      },
    } as Settings

    await waitFor(() => connection.closeCalls > 0)
  })

  it('skips events from vanished authors', async () => {
    const event = await makeEvent('from vanished author', now)
    startWorker([event], {
      userRepository: {
        isVanished: async () => true,
        setVanished: async () => 1,
      },
    })

    await waitFor(() => stateStore.published.some((state) => state.status === 'live'))
    expect(localEvents).to.have.length(0)
    expect(stateStore.published.filter((state) => state.status === 'live').at(-1)?.receivedEvents).to.equal(0)
  })

  it('records a periodic reconciliation failure in peer state', async () => {
    let calls = 0

    startWorker([], {
      reconcileIntervalMs: 500,
      configureConnection: (fake) => {
        const reconcile = fake.reconcile.bind(fake)
        fake.reconcile = async (filter, items) => {
          calls += 1
          if (calls > 1) {
            throw new Error('negentropy timeout')
          }
          return reconcile(filter as any, items)
        }
      },
    })

    await waitFor(() => stateStore.published.some((state) => state.status === 'live'))
    await waitFor(() =>
      stateStore.published.some((state) => state.status === 'error' && state.lastError === 'negentropy timeout'),
    )
  })

  it('records an error when the peer has no peering advertisement', async () => {
    connection = new FakeConnection([])
    const settings = {
      info: { relay_url: 'wss://relay.example.com' },
      peering: {
        enabled: true,
        peers: [{ pubkey: peerPubkey, relayUrl: 'wss://peer.example.com', enabled: true }],
      },
    } as Settings

    worker = new PeeringSyncWorker(fakeProcess as unknown as NodeJS.Process, () => settings, eventRepository, {
      authenticate: async () => ({ socket: { close: () => {} }, challenge: 'c', authEvent: {} }) as any,
      fetchAdvertisement: async () => ({
        enabled: false,
        supportedNips: [1],
        scopes: [],
        terms: [],
      }),
      createConnection: () => connection as any,
      stateStore,
      privateKey: () => privateKey,
      reconnectDelayMs: 1_000,
    })

    worker.run()

    await waitFor(() => stateStore.published.some((state) => state.status === 'error'))
    expect(stateStore.published.some((state) => state.lastError === 'peer does not advertise peering')).to.equal(true)
  })
})
