import { CreateInvoiceRequest, CreateInvoiceResponse, IPaymentsProcessor } from '../@types/clients'

export class PaymentsProcessor implements IPaymentsProcessor {
  public constructor(
    private readonly processor: IPaymentsProcessor
  ) {}

  public async createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    return this.processor.createInvoice(request)
  }
}
