import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

import { IKPICollector, SnapshotService } from '../../../src/dashboard-service/services/snapshot-service'
import { DashboardMetrics } from '../../../src/dashboard-service/types'

chai.use(chaiAsPromised)

const createMetrics = (overrides: Partial<DashboardMetrics> = {}): DashboardMetrics => ({
  eventsByKind: [],
  admittedUsers: 0,
  satsPaid: 0,
  topTalkers: {
    allTime: [],
    recent: [],
  },
  ...overrides,
})

const makeCollector = (stub: Sinon.SinonStub): IKPICollector => ({
  collectMetrics: stub,
})

describe('SnapshotService', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('updates snapshot when collected metrics change', async () => {
    const firstMetrics = createMetrics({ admittedUsers: 1 })
    const nextMetrics = createMetrics({ admittedUsers: 2 })

    const stub = sandbox.stub()
      .onFirstCall().resolves(firstMetrics)
      .onSecondCall().resolves(firstMetrics)
      .onThirdCall().resolves(nextMetrics)

    const service = new SnapshotService(makeCollector(stub))

    const first = await service.refresh()
    expect(first.changed).to.equal(true, 'first refresh should report changed')
    expect(first.snapshot.sequence).to.equal(1)
    expect(first.snapshot.status).to.equal('live')

    const second = await service.refresh()
    expect(second.changed).to.equal(false, 'second refresh with same metrics should not change')
    expect(second.snapshot.sequence).to.equal(1, 'sequence must not advance when metrics are unchanged')

    const third = await service.refresh()
    expect(third.changed).to.equal(true, 'third refresh with new metrics should report changed')
    expect(third.snapshot.sequence).to.equal(2)
    expect(third.snapshot.metrics.admittedUsers).to.equal(2)
  })

  it('does not advance sequence when metrics are identical across refreshes', async () => {
    const metrics = createMetrics({ satsPaid: 100 })
    const stub = sandbox.stub().resolves(metrics)

    const service = new SnapshotService(makeCollector(stub))

    const first = await service.refresh()
    expect(first.changed).to.equal(true)
    expect(first.snapshot.sequence).to.equal(1)

    const second = await service.refresh()
    expect(second.changed).to.equal(false)
    expect(second.snapshot.sequence).to.equal(1)
  })

  it('propagates collector errors to the caller', async () => {
    const stub = sandbox.stub().rejects(new Error('db down'))

    const service = new SnapshotService(makeCollector(stub))

    await expect(service.refresh()).to.be.rejectedWith('db down')
  })

  it('returns the last known snapshot via getSnapshot()', async () => {
    const metrics = createMetrics({ admittedUsers: 5 })
    const stub = sandbox.stub().resolves(metrics)

    const service = new SnapshotService(makeCollector(stub))

    await service.refresh()

    const snap = service.getSnapshot()
    expect(snap.sequence).to.equal(1)
    expect(snap.status).to.equal('live')
    expect(snap.metrics.admittedUsers).to.equal(5)
  })

  it('sets status to live after a successful refresh', async () => {
    const stub = sandbox.stub().resolves(createMetrics())

    const service = new SnapshotService(makeCollector(stub))

    const { snapshot } = await service.refresh()
    expect(snapshot.status).to.equal('live')
  })
})
