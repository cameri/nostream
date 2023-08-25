import { createSettings } from '../settings-factory'
import { GetInvoicePubkeyCheckController } from '../../controllers/invoices/get-invoice-pubkey-check-controller'
import { getMasterDbClient } from '../../database/client'
import { slidingWindowRateLimiterFactory } from '../rate-limiter-factory'
import { UserRepository } from '../../repositories/user-repository'

export const createGetInvoicePubkeyCheckController = () => {
  const dbClient = getMasterDbClient()
  const userRepository = new UserRepository(dbClient)
  
  return new GetInvoicePubkeyCheckController(
    userRepository,
    createSettings,
    slidingWindowRateLimiterFactory
  )
}
