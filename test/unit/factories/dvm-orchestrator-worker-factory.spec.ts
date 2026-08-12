import { expect } from 'chai'

import { DvmOrchestratorWorker } from '../../../src/app/dvm-orchestrator-worker'
import { dvmOrchestratorWorkerFactory } from '../../../src/factories/dvm-orchestrator-worker-factory'

describe('dvmOrchestratorWorkerFactory', () => {
  it('returns a DvmOrchestratorWorker', () => {
    expect(dvmOrchestratorWorkerFactory()).to.be.an.instanceOf(DvmOrchestratorWorker)
  })
})
