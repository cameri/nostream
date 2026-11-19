import { DatabaseTransaction, Pubkey } from './base'
import { Event } from './event'
import { Invoice } from './invoice'
import { NotificationOutboxPayload } from './notification-outbox'
import { PeeringAccess, PeeringAdvertisement, PeeringBudgetSummary, PeeringInvoice, PeeringInvoiceStatus } from './peering'
import { PeeringPeer } from './settings'

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
  /**
   * Fire-and-forget: kicks off the initial graph build without waiting on it,
   * so the first real getDistance() call after startup doesn't have to pay
   * for a cold-start rebuild itself.
   */
  warmUp(): void
}

export interface IPaymentsService {
  getInvoiceFromPaymentsProcessor(invoice: string | Invoice): Promise<Partial<Invoice>>
  createInvoice(pubkey: Pubkey, amount: bigint, description: string, planId?: string): Promise<Invoice>
  updateInvoice(invoice: Partial<Invoice>): Promise<void>
  updateInvoiceStatus(invoice: Pick<Invoice, 'id' | 'status'>): Promise<Invoice>
  confirmInvoice(
    invoice: Pick<Invoice, 'id' | 'amountPaid' | 'confirmedAt' | 'status' | 'pubkey'> &
      Partial<Pick<Invoice, 'planId'>>,
  ): Promise<void>
  sendInvoiceUpdateNotification(invoice: Invoice): Promise<void>
  /** Tells the subscriber, with a kind 402 event, that their renewal invoice can be paid. */
  sendRenewalNotification(invoice: Invoice): Promise<void>
  /** Creates a peering invoice outside the admission/user flow. */
  createPeeringInvoice(
    pubkey: Pubkey,
    amountMsats: bigint,
    description: string,
    termPeriodSeconds: number,
    client?: DatabaseTransaction,
  ): Promise<Invoice>
  /** Publishes a peering invoice as a signed, p-tagged kind 402 event. */
  sendPeeringInvoiceNotification(invoice: Invoice): Promise<void>
  /** Publishes only when no unexpired kind 402 event for this invoice exists. */
  ensurePeeringInvoiceNotification(invoice: Invoice): Promise<void>
  getPendingInvoices(offset?: number): Promise<Invoice[]>
  /** Completed peering invoices whose settlement did not commit, for retry. */
  getUnconfirmedPeeringInvoices(limit?: number, offset?: number): Promise<Invoice[]>
  /** Pays a BOLT11 invoice from the configured wallet and returns its payment hash. */
  payInvoice(bolt11: string): Promise<string>
}

export interface IPeeringBillingService {
  /** Access decision for a configured peer's feed. Optionally rechecks a pending invoice first. */
  getAccess(peerPubkey: Pubkey, options?: { now?: Date; recheck?: boolean }): Promise<PeeringAccess>
  /** Returns a usable invoice, creating or reissuing one when needed. */
  ensureInvoice(peerPubkey: Pubkey, options?: { now?: Date; renewal?: boolean }): Promise<Invoice | undefined>
  /** Ends expired periods once, marking them lapsed and alerting the operator. */
  processLapses(now?: Date): Promise<number>
  /** Renewal window, period end/lapse, and invoice expiry bookkeeping. */
  processLifecycle(now?: Date): Promise<number>
  /** Clears a pointer and updates status after the processor confirms an invoice expired. */
  handleInvoiceExpired(invoice: Invoice): Promise<void>
}

export interface IPeeringBuyerService {
  /** Validates a kind 402 invoice from a peer, then auto-pays or holds it. */
  handleInvoice(
    peer: PeeringPeer,
    advertisement: PeeringAdvertisement,
    event: Event,
    now?: Date,
  ): Promise<PeeringInvoice>
  /** Pays a held invoice on operator approval, bypassing the auto-pay budget guard. */
  approve(paymentHash: string, now?: Date): Promise<PeeringInvoice>
  /** Rejects a held invoice without paying it. */
  reject(paymentHash: string): Promise<PeeringInvoice>
  /** Recent buyer invoices for the admin console. */
  list(statuses?: PeeringInvoiceStatus[], limit?: number): Promise<PeeringInvoice[]>
  /** Spend, remaining budget and invoice counts for the current period. */
  budgetSummary(now?: Date): Promise<PeeringBudgetSummary[]>
  /** Finishes invoices left in PAYING by a restart, before retrying anything. */
  recover(now?: Date): Promise<number>
}

export interface ISubscriptionService {
  /** One pass of renewal invoices, period ends and grace expiries. Returns how many subscriptions changed. */
  processLifecycle(now?: Date): Promise<number>
}

export interface NotificationDispatchContext {
  outboxId?: string
  attemptNumber?: number
}

export interface INotificationDispatcher {
  dispatch(eventType: string, payload: NotificationOutboxPayload, context?: NotificationDispatchContext): Promise<void>
}

export interface IOperatorNotificationService extends INotificationDispatcher {
  dispatchTestTarget(targetId: string): Promise<void>
  getMaxAttempts(): number
  getBaseDelayMs(): number
}

export interface INotificationOutboxService {
  processBatch(limit?: number): Promise<number>
}
