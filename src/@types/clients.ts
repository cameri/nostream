export interface InvoiceEnvelope {
  bolt11: string
}

export interface CreateInvoiceResponse {
  externalReference: string
  amount: number
  invoice: InvoiceEnvelope
}

export interface CreateInvoiceRequest {
  amountMsats: number
  description?: string
  requestId?: string
}

export interface IPaymentsProcessor {
  createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse>
}
