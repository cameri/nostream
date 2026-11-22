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
  /**
   * True when the wallet reports the payment settled. False/absent means the
   * submit was accepted but the outcome is still pending; the invoice stays
   * PAYING and recovery checks it later.
   */
  settled?: boolean
}

/** The configured processor only creates/reads incoming invoices; it cannot spend. */
export class PaymentsProcessorCannotPayError extends Error {
  public constructor() {
    super('the configured payments processor cannot pay a BOLT11 invoice')
    this.name = 'PaymentsProcessorCannotPayError'
  }
}

/** The submit may have reached the wallet but its outcome is unknown. */
export class PaymentsProcessorOutcomeUnknownError extends Error {
  public constructor(message = 'the wallet did not report the payment outcome') {
    super(message)
    this.name = 'PaymentsProcessorOutcomeUnknownError'
  }
}

export interface IPaymentsProcessor {
  createInvoice(request: CreateInvoiceRequest): Promise<CreateInvoiceResponse>
  getInvoice(
    invoice: string | Invoice,
    direction?: 'incoming' | 'outgoing',
  ): Promise<GetInvoiceResponse>
  /** Pays a BOLT11 invoice from the processor wallet. Absent on receive-only adapters. */
  payInvoice?(request: PayInvoiceRequest): Promise<PayInvoiceResponse>
}
