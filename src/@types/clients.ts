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
  verifyURL?: string
}

export interface CreateInvoiceRequest {
  amount: bigint
  description?: string
  requestId?: string
}

export type GetInvoiceResponse = Partial<Invoice>

export interface PayInvoiceRequest {
  bolt11: string
}

export interface PayInvoiceResponse {
  /** BOLT11 payment hash, used as the buyer-side dedupe key. */
  paymentHash: string
  preimage?: string
}

/** The configured processor only creates/reads incoming invoices; it cannot spend. */
export class PaymentsProcessorCannotPayError extends Error {
  public constructor() {
    super('the configured payments processor cannot pay a BOLT11 invoice')
    this.name = 'PaymentsProcessorCannotPayError'
  }
}

export interface IPaymentsProcessor {
  createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse>
  getInvoice(invoice: string | Invoice): Promise<GetInvoiceResponse>
  /** Pays a BOLT11 invoice from the processor wallet. Absent on receive-only adapters. */
  payInvoice?(request: PayInvoiceRequest): Promise<PayInvoiceResponse>
}
