import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createSettings } from './settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { MaintenanceService } from '../services/maintenance-service'

export const createMaintenanceService = () => {
  return new MaintenanceService(new EventRepository(getMasterDbClient(), getReadReplicaDbClient()), createSettings)
}
