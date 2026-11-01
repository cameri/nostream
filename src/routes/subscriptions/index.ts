import { createGetSubscriptionStatusController } from '../../factories/controllers/get-subscription-status-controller-factory'
import { Router } from 'express'
import { withController } from '../../handlers/request-handlers/with-controller-request-handler'

const subscriptionRouter: Router = Router()

subscriptionRouter.get('/status', withController(createGetSubscriptionStatusController))

export default subscriptionRouter
