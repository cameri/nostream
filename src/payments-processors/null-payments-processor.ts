import { CreateInvoiceRequest, CreateInvoiceResponse, IPaymentsProcessor } from '../@types/clients'

export class NullPaymentsProcessor implements IPaymentsProcessor {
  public async createInvoice(_request: CreateInvoiceRequest): Promise<CreateInvoiceResponse> {
    return {
      amount: 0,
      externalReference: '',
      invoice: {
        bolt11: '',
      },
    }
  }
}
