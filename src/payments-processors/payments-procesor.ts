import { CreateInvoiceRequest, CreateInvoiceResponse, GetInvoiceResponse, IPaymentsProcessor } from '../@types/clients'
import { Invoice } from '../@types/invoice'

export class PaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private readonly processor: IPaymentsProcessor
  ) {}

  public async getInvoice(invoice: string | Invoice): Promise<GetInvoiceResponse> {
    return this.processor.getInvoice(invoice)
  }

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    return this.processor.createInvoice(request)
  }
}
