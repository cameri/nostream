import { createPaymentsService } from '../payments-service-factory'
import { getMasterDbClient } from '../../database/client'
import { IController } from '../../@types/controllers'
import { InvoiceRepository } from '../../repositories/invoice-repository'
import { LNbitsCallbackController } from '../../controllers/callbacks/lnbits-callback-controller'

export const createLNbitsCallbackController = (): IController => {
  return new LNbitsCallbackController(
    createPaymentsService(),
    new InvoiceRepository(getMasterDbClient())
  )
}
