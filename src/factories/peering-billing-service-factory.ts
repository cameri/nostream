import cluster from 'cluster'
import { WebSocketServerAdapterEvent } from '../constants/adapter'
import { getMasterDbClient } from '../database/client'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { NotificationOutboxRepository } from '../repositories/notification-outbox-repository'
import { PeeringPaymentRepository } from '../repositories/peering-payment-repository'
import { PeeringBillingService } from '../services/peering-billing-service'
import { createPaymentsService } from './payments-service-factory'
import { createSettings } from './settings-factory'

/**
 * A worker cannot reach another worker's sockets. The primary fans this message out
 * to every client worker, and WebSocketServerAdapter closes the matching peer sockets.
 */
const revokePeer = (pubkey: string): void => {
  if (!cluster.isWorker || typeof process.send !== 'function') {
    return
  }

  process.send({
    eventName: WebSocketServerAdapterEvent.PeeringRevoke,
    event: { pubkey },
  })
}

export const createPeeringBillingService = (): PeeringBillingService => {
  const dbClient = getMasterDbClient()

  return new PeeringBillingService(
    dbClient,
    new PeeringPaymentRepository(dbClient),
    new InvoiceRepository(dbClient),
    createPaymentsService(),
    new NotificationOutboxRepository(dbClient),
    createSettings,
    revokePeer,
  )
}
