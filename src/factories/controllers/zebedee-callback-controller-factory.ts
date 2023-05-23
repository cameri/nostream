import { createPaymentsService } from '../payments-service-factory'
import { IController } from '../../@types/controllers'
import { ZebedeeCallbackController } from '../../controllers/callbacks/zebedee-callback-controller'

export const createZebedeeCallbackController = (): IController => {
  return new ZebedeeCallbackController(
    createPaymentsService(),
  )
}
