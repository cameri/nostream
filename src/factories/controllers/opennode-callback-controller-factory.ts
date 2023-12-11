import { createPaymentsService } from '../payments-service-factory'
import { IController } from '../../@types/controllers'
import { OpenNodeCallbackController } from '../../controllers/callbacks/opennode-callback-controller'

export const createOpenNodeCallbackController = (): IController => {
  return new OpenNodeCallbackController(
    createPaymentsService(),
  )
}
