import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createPaymentsProcessor } from './payments-processor-factory'
import { createSettings } from './settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { MaintenanceWorker } from '../app/maintenance-worker'
import { PaymentsService } from '../services/payments-service'
import { UserRepository } from '../repositories/user-repository'

export const maintenanceWorkerFactory = () => {
  const dbClient = getMasterDbClient()
  const rrDbClient = getReadReplicaDbClient()
  const paymentsProcessor = createPaymentsProcessor()
  const userRepository = new UserRepository(dbClient)
  const invoiceRepository = new InvoiceRepository(dbClient)
  const eventRepository = new EventRepository(dbClient, rrDbClient)

  const paymentsService = new PaymentsService(
    dbClient,
    paymentsProcessor,
    userRepository,
    invoiceRepository,
    eventRepository,
    createSettings,
  )

  return new MaintenanceWorker(process, paymentsService, createSettings)
}
