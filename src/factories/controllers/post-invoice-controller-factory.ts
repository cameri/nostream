import { createPaymentsService } from '../payments-service-factory'
import { createSettings } from '../settings-factory'
import { getMasterDbClient } from '../../database/client'
import { IController } from '../../@types/controllers'
import { PostInvoiceController } from '../../controllers/invoices/post-invoice-controller'
import { slidingWindowRateLimiterFactory } from '../rate-limiter-factory'
import { UserRepository } from '../../repositories/user-repository'

export const createPostInvoiceController = (): IController => {
  const dbClient = getMasterDbClient()
  const userRepository = new UserRepository(dbClient)
  const paymentsService = createPaymentsService()

  return new PostInvoiceController(
    userRepository,
    paymentsService,
    createSettings,
    slidingWindowRateLimiterFactory,
  )
}
