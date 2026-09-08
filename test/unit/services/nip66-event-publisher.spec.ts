import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)

const { expect } = chai
const require = createRequire(fileURLToPath(import.meta.url))
const eventUtils = require('../../../src/utils/event') as typeof import('../../../src/utils/event')
const monitorIdentity = require('../../../src/utils/monitor-identity') as typeof import('../../../src/utils/monitor-identity')
const {
  NIP66_MONITOR_BOOTSTRAP_TTL_SECONDS,
  NIP66_MONITOR_BOOTSTRAPPED_KEY,
  Nip66EventPublisher,
} = require('../../../src/services/nip66-event-publisher') as typeof import('../../../src/services/nip66-event-publisher')

const monitorPrivkey = '0000000000000000000000000000000000000000000000000000000000000001'

describe('Nip66EventPublisher', () => {
  let sandbox: Sinon.SinonSandbox
  let eventRepository: { upsert: Sinon.SinonStub }
  let cache: { getKey: Sinon.SinonStub; setKey: Sinon.SinonStub }
  let publisher: InstanceType<typeof Nip66EventPublisher>

  const settings = {
    info: { relay_url: 'wss://relay.example.com', name: 'relay.example.com' },
    nip66: {
      enabled: true,
      probeIntervalSeconds: 3600,
      targets: ['wss://external.example.com'],
      timeouts: { dnsMs: 1, tlsMs: 1, wsRttMs: 1, nip11Ms: 1 },
      dnsCacheTtlSeconds: 300,
    },
  }

  const snapshot = {
    runAt: '2026-01-01T00:00:00.000Z',
    targets: ['wss://external.example.com'],
    status: 'ok',
    results: [
      {
        target: {
          relayUrl: 'wss://external.example.com',
          hostname: 'external.example.com',
          networkType: 'clearnet',
          httpOrigin: 'https://external.example.com',
          nip11Url: 'https://external.example.com/',
          wsUrl: 'wss://external.example.com',
        },
        checkedAt: '2026-01-01T00:00:00.000Z',
        dns: { status: 'ok', durationMs: 1 },
        tls: { status: 'ok', durationMs: 1 },
        wsRtt: { status: 'ok', durationMs: 1, data: { rttOpenMs: 100, address: 'wss://external.example.com' } },
        nip11: { status: 'ok', durationMs: 1, data: { statusCode: 200 } },
      },
    ],
  }

  let monitorPubkey: string

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    monitorPubkey = eventUtils.getPublicKey(monitorPrivkey)
    eventRepository = { upsert: sandbox.stub().resolves(1) }
    cache = {
      getKey: sandbox.stub().resolves(null),
      setKey: sandbox.stub().resolves(true),
    }
    publisher = new Nip66EventPublisher(eventRepository, cache)

    sandbox.stub(monitorIdentity, 'getMonitorPrivateKey').returns(monitorPrivkey)
    sandbox.stub(eventUtils, 'getPublicKey').returns(monitorPubkey)
    sandbox.stub(eventUtils, 'identifyEvent').callsFake(async (event) => ({ ...event, id: 'event-id' }))
    sandbox.stub(eventUtils, 'signEvent').returns(async (event: any) => ({ ...event, sig: 'sig' }))
    sandbox.stub(eventUtils, 'broadcastEvent').resolves({} as any)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('skips publish when MONITOR_PRIVATE_KEY is missing', async () => {
    ;(monitorIdentity.getMonitorPrivateKey as Sinon.SinonStub).returns(undefined)

    await publisher.publishAfterProbe(snapshot as any, settings as any)

    expect(eventRepository.upsert).to.not.have.been.called
  })

  it('bootstraps once and broadcasts newly persisted events', async () => {
    await publisher.publishAfterProbe(snapshot as any, settings as any)

    expect(cache.setKey).to.have.been.calledOnceWithExactly(
      NIP66_MONITOR_BOOTSTRAPPED_KEY,
      monitorPubkey,
      NIP66_MONITOR_BOOTSTRAP_TTL_SECONDS,
    )
    expect(eventRepository.upsert).to.have.callCount(4)
    expect(eventUtils.broadcastEvent).to.have.callCount(4)

    const relayListEvent = (eventUtils.identifyEvent as Sinon.SinonStub).getCall(1).args[0]
    expect(relayListEvent.kind).to.equal(10002)
    expect(relayListEvent.tags[0]).to.deep.equal(['r', 'wss://relay.example.com', 'read'])
  })

  it('does not rebootstrap when the bootstrap flag is already set', async () => {
    cache.getKey.resolves(monitorPubkey)

    await publisher.publishAfterProbe(snapshot as any, settings as any)

    expect(cache.setKey).to.not.have.been.called
    expect(eventRepository.upsert).to.have.callCount(2)
  })

  it('does not broadcast duplicate upserts', async () => {
    cache.getKey.resolves(monitorPubkey)
    eventRepository.upsert.resolves(0)

    await publisher.publishAfterProbe(snapshot as any, settings as any)

    expect(eventRepository.upsert).to.have.callCount(2)
    expect(eventUtils.broadcastEvent).to.not.have.been.called
  })
})
