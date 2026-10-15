import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createEventRepository } from './event-repository-factory'
import { createSettings } from './settings-factory'
import { MaintenanceService } from '../services/maintenance-service'

export const createMaintenanceService = () => {
  return new MaintenanceService(createEventRepository(getMasterDbClient(), getReadReplicaDbClient()), createSettings)
}
