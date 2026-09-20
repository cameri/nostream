import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { EventKinds } from '../../../src/constants/base'
import { Nip66EventPublisher, NIP66_MONITOR_BOOTSTRAPPED_KEY } from '../../../src/services/nip66-event-publisher'
import * as eventUtils from '../../../src/utils/event'
import { resetMonitorPrivateKeyCache } from '../../../src/utils/monitor-identity'

chai.use(sinonChai)

const { expect } = chai

const PRIVKEY = 'f'.repeat(64)

describe('Nip66EventPublisher', () => {
  let sandbox: Sinon.SinonSandbox
  let eventRepository: { upsert: Sinon.SinonStub }
  let cache: { getKey: Sinon.SinonStub; setKey: Sinon.SinonStub }
  let publisher: Nip66EventPublisher

  const settings = {
    info: { relay_url: 'wss://relay.example.com' },
    nip66: { enabled: true, probeIntervalSeconds: 3600, targets: ['wss://other.example.com'], timeouts: {} },
  } as any

  const snapshot = {
    runAt: new Date().toISOString(),
    targets: ['wss://relay.example.com'],
    status: 'ok',
    results: [],
  } as any

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    resetMonitorPrivateKeyCache()
    process.env.MONITOR_PRIVATE_KEY = PRIVKEY

    eventRepository = { upsert: sandbox.stub().resolves() }
    cache = {
      getKey: sandbox.stub().resolves(undefined),
      setKey: sandbox.stub().resolves(),
    }

    sandbox.stub(eventUtils, 'getPublicKey').returns('b'.repeat(64))
    sandbox.stub(eventUtils, 'identifyEvent').callsFake(async (event: any) => ({ ...event, id: 'id'.repeat(16) }))
    sandbox.stub(eventUtils, 'signEvent').returns(async (event: any) => ({ ...event, sig: 'sig'.repeat(32) }))
    sandbox.stub(eventUtils, 'isParameterizedReplaceableEvent').returns(false)

    publisher = new Nip66EventPublisher(eventRepository as any, cache as any)
  })

  afterEach(() => {
    delete process.env.MONITOR_PRIVATE_KEY
    resetMonitorPrivateKeyCache()
    sandbox.restore()
  })

  it('bootstraps with the public relay URL from settings', async () => {
    await publisher.publishAfterProbe(snapshot, settings)

    const relayListUpsert = eventRepository.upsert.getCalls().find((call) => call.args[0].kind === EventKinds.RELAY_LIST)

    expect(relayListUpsert).to.exist
    expect(relayListUpsert!.args[0].tags).to.deep.include(['r', 'wss://relay.example.com', 'read'])
    expect(cache.setKey).to.have.been.calledWith(NIP66_MONITOR_BOOTSTRAPPED_KEY, 'b'.repeat(64))
  })

  it('re-bootstraps when the monitor pubkey changes', async () => {
    cache.getKey.resolves('a'.repeat(64))

    await publisher.publishAfterProbe(snapshot, settings)

    const profileUpserts = eventRepository.upsert
      .getCalls()
      .filter((call) => call.args[0].kind === EventKinds.SET_METADATA)

    expect(profileUpserts).to.have.length(1)
    expect(cache.setKey).to.have.been.calledWith(NIP66_MONITOR_BOOTSTRAPPED_KEY, 'b'.repeat(64))
  })
})
