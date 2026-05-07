import { expect } from 'chai'

import { MaintenanceService } from '../../../src/services/maintenance-service'
import { createMaintenanceService } from '../../../src/factories/maintenance-service-factory'

describe('createMaintenanceService', () => {
  it('returns a MaintenanceService', () => {
    expect(createMaintenanceService()).to.be.an.instanceOf(MaintenanceService)
  })
})
