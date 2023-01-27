import { createPaymentsProcessor } from './payments-processor-factory'
import { createSettings } from './settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { getDbClient } from '../database/client'
import { IController } from '../@types/controllers'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { PaymentsService } from '../services/payments-service'
import { PostInvoiceController } from '../controllers/invoices/post-invoice-controller'
import { slidingWindowRateLimiterFactory } from './rate-limiter-factory'
import { UserRepository } from '../repositories/user-repository'

export const createPostInvoiceController = (): IController => {
  const dbClient = getDbClient()
  const eventRepository = new EventRepository(dbClient)
  const invoiceRepository = new InvoiceRepository(dbClient)
  const userRepository = new UserRepository(dbClient)
  const paymentsProcessor = createPaymentsProcessor()
  const paymentsService = new PaymentsService(
    dbClient,
    paymentsProcessor,
    userRepository,
    invoiceRepository,
    eventRepository,
    createSettings,
  )

  return new PostInvoiceController(
    userRepository,
    paymentsService,
    createSettings,
    slidingWindowRateLimiterFactory,
  )
}
