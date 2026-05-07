import { expect } from 'chai'

import { MaintenanceWorker } from '../../../src/app/maintenance-worker'
import { maintenanceWorkerFactory } from '../../../src/factories/maintenance-worker-factory'

describe('maintenanceWorkerFactory', () => {
  it('returns a MaintenanceWorker', () => {
    expect(maintenanceWorkerFactory()).to.be.an.instanceOf(MaintenanceWorker)
  })
})
