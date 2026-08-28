import { Invoice } from './invoice'
import { Pubkey } from './base'

export interface IMaintenanceService {
  clearOldEvents(): Promise<void>
}

export interface IWotGraphService {
  /** True once the trust graph has completed at least one build. */
  isReady(): boolean
  /**
   * Distance (in hops) from the configured seed pubkey, or undefined if the
   * pubkey is outside the configured trust depth (or WoT is disabled).
   */
  getDistance(pubkey: Pubkey): Promise<number | undefined>
  isTrusted(pubkey: Pubkey): Promise<boolean>
  /** Applies a pubkey's current NIP-02 follow list to the graph. */
  updateFollowList(pubkey: Pubkey, follows: Pubkey[]): Promise<void>
}

export interface IPaymentsService {
  getInvoiceFromPaymentsProcessor(invoice: string | Invoice): Promise<Partial<Invoice>>
  createInvoice(pubkey: Pubkey, amount: bigint, description: string): Promise<Invoice>
  updateInvoice(invoice: Partial<Invoice>): Promise<void>
  updateInvoiceStatus(invoice: Pick<Invoice, 'id' | 'status'>): Promise<Invoice>
  confirmInvoice(invoice: Pick<Invoice, 'id' | 'amountPaid' | 'confirmedAt' | 'status' | 'pubkey'>): Promise<void>
  sendInvoiceUpdateNotification(invoice: Invoice): Promise<void>
  getPendingInvoices(): Promise<Invoice[]>
}
