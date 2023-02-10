import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createPaymentsProcessor } from './payments-processor-factory'
import { createSettings } from './settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { IController } from '../@types/controllers'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { LnbitsCallbackController } from '../controllers/callbacks/lnbits-callback-controller'
import { PaymentsService } from '../services/payments-service'
import { UserRepository } from '../repositories/user-repository'

export const createLnbitsallbackController = (): IController => {
  const dbClient = getMasterDbClient()
  const rrDbClient = getReadReplicaDbClient()
  const eventRepository = new EventRepository(dbClient, rrDbClient)
  const invoiceRepository = new InvoiceRepository(dbClient)
  const userRepository = new UserRepository(dbClient)
  const paymentsProcessor = createPaymentsProcessor(invoiceRepository)
  const paymentsService = new PaymentsService(
    dbClient,
    paymentsProcessor,
    userRepository,
    invoiceRepository,
    eventRepository,
    createSettings,
  )

  return new LnbitsCallbackController(
    paymentsService,
  )
}
