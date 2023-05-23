import { GetInvoiceStatusController } from '../../controllers/invoices/get-invoice-status-controller'
import { getReadReplicaDbClient } from '../../database/client'
import { InvoiceRepository } from '../../repositories/invoice-repository'

export const createGetInvoiceStatusController = () => {
  const rrDbClient = getReadReplicaDbClient()

  const invoiceRepository = new InvoiceRepository(rrDbClient)

  return new GetInvoiceStatusController(invoiceRepository)
}
