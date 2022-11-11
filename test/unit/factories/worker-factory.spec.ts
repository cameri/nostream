import { expect } from 'chai'
import Sinon from 'sinon'

import * as databaseClientModule from '../../../src/database/client'

import { AppWorker } from '../../../src/app/worker'
import { workerFactory } from '../../../src/factories/worker-factory'

describe('workerFactory', () => {
  let getDbClientStub: Sinon.SinonStub

  beforeEach(() => {
    getDbClientStub = Sinon.stub(databaseClientModule, 'getDbClient')
  })

  afterEach(() => {
    getDbClientStub.restore()
  })

  it('returns an AppWorker', () => {
    const worker = workerFactory()
    expect(worker).to.be.an.instanceOf(AppWorker)
    worker.close()
  })
})
