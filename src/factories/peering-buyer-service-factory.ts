import { getMasterDbClient } from '../database/client'
import { NotificationOutboxRepository } from '../repositories/notification-outbox-repository'
import { PeeringInvoiceRepository } from '../repositories/peering-invoice-repository'
import { PeeringBuyerService } from '../services/peering-buyer-service'
import { createPaymentsService } from './payments-service-factory'
import { createSettings } from './settings-factory'

export const createPeeringBuyerService = (): PeeringBuyerService => {
  const dbClient = getMasterDbClient()

  return new PeeringBuyerService(
    dbClient,
    new PeeringInvoiceRepository(dbClient),
    createPaymentsService(),
    new NotificationOutboxRepository(dbClient),
    createSettings,
  )
}
