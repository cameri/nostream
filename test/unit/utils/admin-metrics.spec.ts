import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
const { expect } = chai

import * as adminHealth from '../../../src/utils/admin-health'
import * as adminMetrics from '../../../src/utils/admin-metrics'
import * as prometheusClient from '../../../src/utils/prometheus-client'

describe('admin-metrics', () => {
  let sandbox: Sinon.SinonSandbox
  let queryPrometheusInstantStub: Sinon.SinonStub
  let collectAdminHealthSnapshotStub: Sinon.SinonStub

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    queryPrometheusInstantStub = sandbox.stub(prometheusClient, 'queryPrometheusInstant')
    collectAdminHealthSnapshotStub = sandbox.stub(adminHealth, 'collectAdminHealthSnapshot').resolves({
      status: 'ok',
      uptimeSeconds: 10,
      worker: { type: 'worker', index: '0' },
      database: { ok: true },
      redis: { ok: true },
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('builds a snapshot from prometheus queries and dependency health', async () => {
    queryPrometheusInstantStub.onCall(0).resolves(1.5)
    queryPrometheusInstantStub.onCall(1).resolves(0.25)
    queryPrometheusInstantStub.onCall(2).resolves(100)
    queryPrometheusInstantStub.onCall(3).resolves(4)
    queryPrometheusInstantStub.onCall(4).resolves(12)
    queryPrometheusInstantStub.onCall(5).resolves(33.3)
    queryPrometheusInstantStub.onCall(6).resolves(256)

    const snapshot = await adminMetrics.collectAdminMetricsSnapshot()

    expect(snapshot.status).to.equal('ok')
    expect(snapshot.metrics).to.deep.equal({
      eventsPerSecond: 1.5,
      eventsRejectedPerSecond: 0.25,
      eventsAcceptedTotal: 100,
      eventsRejectedTotal: 4,
      activeConnections: 12,
      cpuLoadPercent: 33.3,
      memoryUsedMb: 256,
    })
    expect(snapshot.health.database.ok).to.equal(true)
    expect(snapshot.prometheus.available).to.equal(true)
    expect(collectAdminHealthSnapshotStub).to.have.been.calledOnce
    expect(queryPrometheusInstantStub.callCount).to.equal(7)
  })

  it('marks snapshot unavailable when prometheus returns no data', async () => {
    queryPrometheusInstantStub.resolves(undefined)

    const snapshot = await adminMetrics.collectAdminMetricsSnapshot()

    expect(snapshot.status).to.equal('unavailable')
    expect(snapshot.prometheus.available).to.equal(false)
    expect(snapshot.metrics.eventsPerSecond).to.equal(0)
  })

  it('marks snapshot degraded when dependency health fails', async () => {
    collectAdminHealthSnapshotStub.resolves({
      status: 'degraded',
      uptimeSeconds: 10,
      worker: { type: 'worker' },
      database: { ok: false },
      redis: { ok: true },
    })
    queryPrometheusInstantStub.onCall(0).resolves(1)

    const snapshot = await adminMetrics.collectAdminMetricsSnapshot()

    expect(snapshot.status).to.equal('degraded')
    expect(snapshot.health.database.ok).to.equal(false)
  })

  describe('getAdminMetricsSseIntervalMs', () => {
    const originalInterval = process.env.ADMIN_METRICS_SSE_INTERVAL_MS

    afterEach(() => {
      if (originalInterval === undefined) {
        delete process.env.ADMIN_METRICS_SSE_INTERVAL_MS
      } else {
        process.env.ADMIN_METRICS_SSE_INTERVAL_MS = originalInterval
      }
    })

    it('defaults to 5000ms', () => {
      delete process.env.ADMIN_METRICS_SSE_INTERVAL_MS

      expect(adminMetrics.getAdminMetricsSseIntervalMs()).to.equal(5000)
    })

    it('falls back when configured interval is invalid', () => {
      process.env.ADMIN_METRICS_SSE_INTERVAL_MS = 'abc'

      expect(adminMetrics.getAdminMetricsSseIntervalMs()).to.equal(5000)
    })
  })
})
