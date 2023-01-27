import { expect } from 'chai'
import Sinon from 'sinon'

import * as databaseClientModule from '../../../src/database/client'

import { AppWorker } from '../../../src/app/worker'
import { workerFactory } from '../../../src/factories/worker-factory'


describe('workerFactory', () => {
  let getMasterDbClientStub: Sinon.SinonStub
  let getReadReplicaDbClientStub: Sinon.SinonStub

  beforeEach(() => {
    getMasterDbClientStub = Sinon.stub(databaseClientModule, 'getMasterDbClient')
    getReadReplicaDbClientStub = Sinon.stub(databaseClientModule, 'getReadReplicaDbClient')
  })

  afterEach(() => {
    getMasterDbClientStub.restore()
    getReadReplicaDbClientStub.restore()
  })

  it('returns an AppWorker', () => {
    const worker = workerFactory()
    expect(worker).to.be.an.instanceOf(AppWorker)
    worker.close()
  })
})
