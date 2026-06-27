import { expect } from 'chai'
import Sinon from 'sinon'

import { AdminMetricsCollector } from '../../../src/utils/admin-metrics'

describe('AdminMetricsCollector', () => {
  let collector: AdminMetricsCollector
  let clock: Sinon.SinonFakeTimers
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    clock = sandbox.useFakeTimers(10000)
    collector = new AdminMetricsCollector()
  })

  afterEach(() => {
    clock.restore()
    sandbox.restore()
  })

  it('returns zeroed snapshot by default', () => {
    const snapshot = collector.getSnapshot()

    expect(snapshot.eventsPerSecond).to.equal(0)
    expect(snapshot.acceptedEvents).to.equal(0)
    expect(snapshot.rejectedEvents).to.equal(0)
    expect(snapshot.activeConnections).to.equal(0)
    expect(snapshot.cpuLoadPercent).to.be.greaterThanOrEqual(0)
    expect(snapshot.memoryUsedMb).to.be.greaterThan(0)
  })

  it('tracks accepted and rejected event counters', () => {
    collector.recordAcceptedEvent()
    collector.recordAcceptedEvent()
    collector.recordRejectedEvent()

    const snapshot = collector.getSnapshot()

    expect(snapshot.acceptedEvents).to.equal(2)
    expect(snapshot.rejectedEvents).to.equal(1)
  })

  it('tracks events per second in a rolling 1-second window', () => {
    collector.recordAcceptedEvent(10000)
    collector.recordRejectedEvent(10500)
    collector.recordRejectedEvent(10999)

    expect(collector.getSnapshot(11000).eventsPerSecond).to.equal(2)
    expect(collector.getSnapshot(11500).eventsPerSecond).to.equal(1)
    expect(collector.getSnapshot(12000).eventsPerSecond).to.equal(0)
  })

  it('tracks active websocket connections by id', () => {
    collector.openConnection('conn-1')
    collector.openConnection('conn-2')
    collector.openConnection('conn-1')

    expect(collector.getSnapshot().activeConnections).to.equal(2)

    collector.closeConnection('conn-2')

    expect(collector.getSnapshot().activeConnections).to.equal(1)
  })
})
