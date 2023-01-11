import { EventRepository } from '../repositories/event-repository'
import { getDbClient } from '../database/client'
import { IController } from '../@types/controllers'
import { InvoiceRepository } from '../repositories/invoice-repository'
import { ZebedeeCallbackController } from '../controllers/callbacks/zebedee-callback-controller'

export const createZebedeeCallbackController = (): IController => {
  const dbClient = getDbClient()
  const eventRepository = new EventRepository(dbClient)
  const invoiceRepotistory = new InvoiceRepository(dbClient)

  return new ZebedeeCallbackController(
    invoiceRepotistory,
    eventRepository,
  )
}
