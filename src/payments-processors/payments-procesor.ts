import { CreateInvoiceRequest, CreateInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { Invoice } from '../@types/invoice'

export class PaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private readonly processor: IPaymentsProcessor
  ) {}

  public async getInvoice(invoiceId: string): Promise<Invoice> {
    return this.processor.getInvoice(invoiceId)
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    return this.processor.createInvoice(request)
  }
}
