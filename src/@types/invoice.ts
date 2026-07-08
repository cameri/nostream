import { Pubkey } from './base'

export enum InvoiceUnit {
  MSATS = 'msats',
  SATS = 'sats',
  BTC = 'btc',
}

export enum InvoiceStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  EXPIRED = 'expired',
}

export enum InvoiceFeeSchedule {
  ADMISSION = 'admission',
  SUBSCRIPTION = 'subscription',
  PUBLICATION = 'publication',
}

export interface Invoice {
  id: string
  pubkey: Pubkey
  bolt11: string
  amountRequested: bigint
  amountPaid?: bigint
  unit: InvoiceUnit
  status: InvoiceStatus
  description: string
  confirmedAt?: Date | null
  expiresAt: Date | null
  updatedAt: Date
  createdAt: Date
  verifyURL?: string
  feeSchedule?: InvoiceFeeSchedule
  planId?: string | null
  subscriptionId?: string | null
  periodStart?: Date | null
  periodEnd?: Date | null
}

export interface LnurlInvoice extends Invoice {
  verifyURL: string
}

export interface DBInvoice {
  id: string
  pubkey: Buffer
  bolt11: string
  amount_requested: bigint
  amount_paid: bigint
  unit: InvoiceUnit
  status: InvoiceStatus
  description: string
  confirmed_at: Date
  expires_at: Date
  updated_at: Date
  created_at: Date
  verify_url: string
  fee_schedule?: InvoiceFeeSchedule
  plan_id?: string | null
  subscription_id?: string | null
  period_start?: Date | null
  period_end?: Date | null
}
