import { createSettings } from '../settings-factory'
import { getMasterDbClient } from '../../database/client'
import { GetSubscriptionStatusController } from '../../controllers/subscriptions/get-subscription-status-controller'
import { rateLimiterFactory } from '../rate-limiter-factory'
import { UserSubscriptionRepository } from '../../repositories/user-subscription-repository'

export const createGetSubscriptionStatusController = () =>
  new GetSubscriptionStatusController(
    new UserSubscriptionRepository(getMasterDbClient()),
    createSettings,
    rateLimiterFactory,
  )
