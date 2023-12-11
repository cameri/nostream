import { createPaymentsService } from '../payments-service-factory'
import { IController } from '../../@types/controllers'
import { NodelessCallbackController } from '../../controllers/callbacks/nodeless-callback-controller'

export const createNodelessCallbackController = (): IController => new NodelessCallbackController(
  createPaymentsService(),
)
