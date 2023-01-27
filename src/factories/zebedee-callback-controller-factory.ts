import { createPaymentsProcessor } from './payments-processor-factory'
import { createSettings } from './settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { getDbClient } from '../database/client'
import { IController } from '../@types/controllers'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { PaymentsService } from '../services/payments-service'
import { UserRepository } from '../repositories/user-repository'
import { ZebedeeCallbackController } from '../controllers/callbacks/zebedee-callback-controller'

export const createZebedeeCallbackController = (): IController => {
  const dbClient = getDbClient()
  const eventRepository = new EventRepository(dbClient)
  const invoiceRepotistory = new InvoiceRepository(dbClient)
  const userRepository = new UserRepository(dbClient)
  const paymentsProcessor = createPaymentsProcessor()
  const paymentsService = new PaymentsService(
    dbClient,
    paymentsProcessor,
    userRepository,
    invoiceRepotistory,
    eventRepository,
    createSettings,
  )

  return new ZebedeeCallbackController(
    paymentsService,
  )
}
