import { getMasterDbClient, getReadReplicaDbClient } from '../../database/client'
import { createEventRepository } from '../event-repository-factory'
import { createPaymentsService } from '../payments-service-factory'
import { createSettings } from '../settings-factory'
import { IController } from '../../@types/controllers'
import { PostInvoiceController } from '../../controllers/invoices/post-invoice-controller'
import { rateLimiterFactory } from '../rate-limiter-factory'
import { UserRepository } from '../../repositories/user-repository'

export const createPostInvoiceController = (): IController => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = createEventRepository(dbClient, readReplicaDbClient)
  const userRepository = new UserRepository(dbClient, eventRepository)
  const paymentsService = createPaymentsService()

  return new PostInvoiceController(userRepository, paymentsService, createSettings, rateLimiterFactory)
}
