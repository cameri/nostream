import { expect } from 'chai'
import Sinon from 'sinon'
import { AppWorker } from '../../../src/app/worker'
import * as cacheClientModule from '../../../src/cache/client'
import * as databaseClientModule from '../../../src/database/client'
import { workerFactory } from '../../../src/factories/worker-factory'
import { ReportRepository } from '../../../src/repositories/report-repository'
import { SettingsStatic } from '../../../src/utils/settings'
import { stopHiddenContentCache } from '../../../src/utils/hidden-content-cache'

describe('workerFactory', () => {
  let createSettingsStub: Sinon.SinonStub
  let getMasterDbClientStub: Sinon.SinonStub
  let getReadReplicaDbClientStub: Sinon.SinonStub
  let getCacheClientStub: Sinon.SinonStub

  beforeEach(() => {
    createSettingsStub = Sinon.stub(SettingsStatic, 'createSettings')
    getMasterDbClientStub = Sinon.stub(databaseClientModule, 'getMasterDbClient')
    getReadReplicaDbClientStub = Sinon.stub(databaseClientModule, 'getReadReplicaDbClient')
    // workerFactory() now constructs the WoT graph singleton at boot (via
    // getCache()), which would otherwise build a real Redis client here.
    const fakeRedisClient: any = { isOpen: true }
    fakeRedisClient.on = Sinon.stub().returns(fakeRedisClient)
    getCacheClientStub = Sinon.stub(cacheClientModule, 'getCacheClient').returns(fakeRedisClient)
  })

  afterEach(() => {
    stopHiddenContentCache()
    getCacheClientStub.restore()
    getReadReplicaDbClientStub.restore()
    getMasterDbClientStub.restore()
    createSettingsStub.restore()
  })

  it('returns an AppWorker', () => {
    createSettingsStub.returns({
      info: {
        relay_url: 'url',
      },
      network: {},
    })

    const worker = workerFactory()
    expect(worker).to.be.an.instanceOf(AppWorker)
    worker.close()
  })

  describe('NIP-56 hidden-content cache warm-up', () => {
    let findActionableTargetsStub: Sinon.SinonStub

    beforeEach(() => {
      findActionableTargetsStub = Sinon.stub(ReportRepository.prototype, 'findActionableTargets').resolves([])
    })

    afterEach(() => {
      findActionableTargetsStub.restore()
    })

    it('reads the DB at boot when nip56.enabled and hideActionableReports are both on', async () => {
      createSettingsStub.returns({
        info: { relay_url: 'url' },
        network: {},
        nip56: { enabled: true, trustedModerators: [], hideActionableReports: true },
      })

      const worker = workerFactory()
      await new Promise((resolve) => setImmediate(resolve))

      expect(findActionableTargetsStub.callCount).to.equal(1)
      worker.close()
    })

    it('starts the polling timer at boot but skips the DB read while hideActionableReports is off', async () => {
      // The timer itself starts regardless of hideActionableReports (cheap,
      // no DB/memory cost), but each tick -- including the initial one --
      // checks the setting fresh and skips the read while it's off, so a
      // later hot-enable is still picked up within one interval without
      // continuously re-reading the full set while the feature is unused.
      createSettingsStub.returns({
        info: { relay_url: 'url' },
        network: {},
        nip56: { enabled: true, trustedModerators: [], hideActionableReports: false },
      })

      const worker = workerFactory()
      await new Promise((resolve) => setImmediate(resolve))

      expect(findActionableTargetsStub.called).to.be.false
      worker.close()
    })

    it('does not start the cache when nip56 is unset', async () => {
      createSettingsStub.returns({
        info: { relay_url: 'url' },
        network: {},
      })

      const worker = workerFactory()
      await new Promise((resolve) => setImmediate(resolve))

      expect(findActionableTargetsStub.called).to.be.false
      worker.close()
    })
  })
})
