import { Invoice } from './invoice'
import { Pubkey } from './base'

export interface IPaymentsService {
  getInvoiceFromPaymentsProcessor(invoice: string | Invoice): Promise<Partial<Invoice>>
  createInvoice(
    pubkey: Pubkey,
    amount: bigint,
    description: string,
  ): Promise<Invoice>
  updateInvoice(invoice: Partial<Invoice>): Promise<void>
  updateInvoiceStatus(invoice: Pick<Invoice, 'id' | 'status'>): Promise<Invoice>
  confirmInvoice(
    invoice: Pick<Invoice, 'id' | 'amountPaid' | 'confirmedAt' | 'status' | 'pubkey'>,
  ): Promise<void>
  sendInvoiceUpdateNotification(invoice: Invoice): Promise<void>
  getPendingInvoices(): Promise<Invoice[]>
}
