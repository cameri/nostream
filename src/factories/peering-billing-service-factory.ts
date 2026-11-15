import { getMasterDbClient } from '../database/client'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { NotificationOutboxRepository } from '../repositories/notification-outbox-repository'
import { PeeringPaymentRepository } from '../repositories/peering-payment-repository'
import { PeeringBillingService } from '../services/peering-billing-service'
import { createPaymentsService } from './payments-service-factory'
import { createSettings } from './settings-factory'

export const createPeeringBillingService = (): PeeringBillingService => {
  const dbClient = getMasterDbClient()

  return new PeeringBillingService(
    dbClient,
    new PeeringPaymentRepository(dbClient),
    new InvoiceRepository(dbClient),
    createPaymentsService(),
    new NotificationOutboxRepository(dbClient),
    createSettings,
  )
}
