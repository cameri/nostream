import { getMasterDbClient } from '../database/client'
import { UserSubscriptionRepository } from '../repositories/user-subscription-repository'
import { SubscriptionService } from '../services/subscription-service'
import { createPaymentsService } from './payments-service-factory'
import { createSettings } from './settings-factory'

export const createSubscriptionService = () =>
  new SubscriptionService(new UserSubscriptionRepository(getMasterDbClient()), createPaymentsService(), createSettings)
