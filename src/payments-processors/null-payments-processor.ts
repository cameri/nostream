import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { InvoiceStatus, InvoiceUnit } from '../@types/invoice'

export class NullPaymentsProcessor implements IPaymentsProcessor {
  public async getInvoice(invoiceId: string): Promise<GetInvoiceResponse> {
    const date = new Date()
    return {
      id: invoiceId,
      pubkey: '',
      bolt11: '',
      description: '',
      status: InvoiceStatus.PENDING,
      unit: InvoiceUnit.MSATS,
      amountRequested: 0n,
      expiresAt: date,
      confirmedAt: null,
      createdAt: date,
      updatedAt: date,
      verifyURL: '',
    }
  }

  public async createInvoice(_request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    return {
      description: '',
      status: InvoiceStatus.PENDING,
      unit: InvoiceUnit.MSATS,
      amountRequested: 0n,
      id: '',
      expiresAt: new Date(),
      bolt11: '',
      pubkey: '',
      rawResponse: '',
      confirmedAt: null,
      createdAt: new Date(),
      verifyURL: '',
    }
  }
}
