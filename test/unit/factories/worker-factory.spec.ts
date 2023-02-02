import { expect } from 'chai'
import Sinon from 'sinon'

import * as databaseClientModule from '../../../src/database/client'

import { AppWorker } from '../../../src/app/worker'
import { SettingsStatic } from '../../../src/utils/settings'
import { workerFactory } from '../../../src/factories/worker-factory'


describe('workerFactory', () => {
  let createSettingsStub: Sinon.SinonStub
  let getMasterDbClientStub: Sinon.SinonStub
  let getReadReplicaDbClientStub: Sinon.SinonStub

  beforeEach(() => {
    createSettingsStub = Sinon.stub(SettingsStatic, 'createSettings')
    getMasterDbClientStub = Sinon.stub(databaseClientModule, 'getMasterDbClient')
    getReadReplicaDbClientStub = Sinon.stub(databaseClientModule, 'getReadReplicaDbClient')
  })

  afterEach(() => {
    getReadReplicaDbClientStub.restore()
    getMasterDbClientStub.restore()
    createSettingsStub.restore()
  })

  it('returns an AppWorker', () => {
    createSettingsStub.returns({
      info: {
        relay_url: 'url',
      },
      network: {

      },
    })

    const worker = workerFactory()
    expect(worker).to.be.an.instanceOf(AppWorker)
    worker.close()
  })
})
