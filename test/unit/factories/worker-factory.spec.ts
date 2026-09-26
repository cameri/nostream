import { expect } from 'chai'
import Sinon from 'sinon'
import { AppWorker } from '../../../src/app/worker'
import * as cacheClientModule from '../../../src/cache/client'
import * as databaseClientModule from '../../../src/database/client'
import { workerFactory } from '../../../src/factories/worker-factory'
import { ReportRepository } from '../../../src/repositories/report-repository'
import { SettingsStatic } from '../../../src/utils/settings'

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

    it('warms the cache at boot when nip56.hideActionableReports is enabled', async () => {
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

    it('does not warm the cache when hideActionableReports is disabled', async () => {
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

    it('does not warm the cache when nip56 is unset', async () => {
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
