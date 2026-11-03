import { expect } from 'chai'
import EventEmitter from 'events'
import { Event } from '../../../src/@types/event'
import { PeeringPeerSyncState } from '../../../src/@types/peering'
import { IEventRepository, ReconciliationItem } from '../../../src/@types/repositories'
import { Settings } from '../../../src/@types/settings'
import { PeeringSyncWorker } from '../../../src/app/peering-sync-worker'
import { getPublicKey, identifyEvent, isEventMatchingFilter, signEvent } from '../../../src/utils/event'
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

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
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

  beforeEach(async () => {
    fakeProcess = Object.assign(new EventEmitter(), {
      exit: () => {},
    })
    localEvents = []
    stateStore = new FakeStateStore()

    eventRepository = {
      findReconciliationItems: async (filter: Parameters<typeof isEventMatchingFilter>[0]) =>
        localEvents
          .filter((event) => isEventMatchingFilter(filter)(event))
          .map((event) => ({ event_created_at: event.created_at, event_id: event.id })),
      upsertMany: async (events: Event[]) => {
        for (const event of events) {
          if (!localEvents.some((local) => local.id === event.id)) {
            localEvents.push(event)
          }
        }
        return events.length
      },
    } as unknown as IEventRepository
  })

  afterEach(() => {
    worker?.close()
  })

  const startWorker = (remoteEvents: Event[]): void => {
    connection = new FakeConnection(remoteEvents)
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
        enabled: true,
        supportedNips: [1, 77],
        self: peerPubkey,
        terms: [],
        scopes: [{ kinds: [1] }],
      }),
      createConnection: () => connection as any,
      stateStore,
      privateKey: () => privateKey,
      reconcileIntervalMs: 60_000,
      reconnectDelayMs: 10,
    })

    worker.run()
  }

  it('converges an empty store from negentropy and then applies live events', async () => {
    const historical = await makeEvent('historical', now - 30)
    startWorker([historical])

    await waitFor(() => localEvents.length === 1)
    expect(localEvents[0].id).to.equal(historical.id)
    expect(connection.liveOnEvent).to.be.a('function')

    await waitFor(() => stateStore.published.some((state) => state.status === 'live'))
    const liveState = stateStore.published.filter((state) => state.status === 'live').at(-1)
    expect(liveState?.lastReconciledAt).to.be.a('string')
    expect(liveState?.missingEvents).to.equal(1)
    expect(liveState?.receivedEvents).to.equal(1)

    const live = await makeEvent('live', now)
    connection.liveOnEvent?.(live)

    await waitFor(() => localEvents.length === 2)
    expect(localEvents.map((event) => event.id)).to.include(live.id)
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
