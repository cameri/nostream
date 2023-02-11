import { createPaymentsService } from './payments-service-factory'
import { createSettings } from './settings-factory'
import { MaintenanceWorker } from '../app/maintenance-worker'

export const maintenanceWorkerFactory = () => {
  return new MaintenanceWorker(process, createPaymentsService(), createSettings)
}
