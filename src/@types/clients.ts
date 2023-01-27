import { Invoice, InvoiceStatus, InvoiceUnit } from './invoice'

export interface CreateInvoiceResponse {
  id: string
  pubkey: string
  bolt11: string
  amountRequested: bigint
  description: string
  unit: InvoiceUnit
  status: InvoiceStatus
  expiresAt: Date | null
  confirmedAt?: Date | null
  createdAt: Date
  rawResponse?: string
}

export interface CreateInvoiceRequest {
  amount: bigint
  description?: string
  requestId?: string
}

export type GetInvoiceResponse = Invoice

export interface IPaymentsProcessor {
  createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse>
  getInvoice(invoiceId: string): Promise<GetInvoiceResponse>
}
