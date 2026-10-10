import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createEventRepository } from './event-repository-factory'
import { createPaymentsProcessor } from './payments-processor-factory'
import { createSettings } from './settings-factory'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { PaymentsService } from '../services/payments-service'
import { UserRepository } from '../repositories/user-repository'
import { NotificationOutboxRepository } from '../repositories/notification-outbox-repository'

export const createPaymentsService = () => {
  const dbClient = getMasterDbClient()
  const rrDbClient = getReadReplicaDbClient()
  const invoiceRepository = new InvoiceRepository(dbClient)
  const eventRepository = createEventRepository(dbClient, rrDbClient)
  const userRepository = new UserRepository(dbClient, eventRepository)
  const notificationOutboxRepository = new NotificationOutboxRepository(dbClient)
  const paymentsProcessor = createPaymentsProcessor()

  return new PaymentsService(
    dbClient,
    paymentsProcessor,
    userRepository,
    invoiceRepository,
    eventRepository,
    createSettings,
    notificationOutboxRepository,
  )
}
