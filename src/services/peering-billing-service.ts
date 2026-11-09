import { DatabaseClient, Pubkey } from '../@types/base'
import { Invoice, InvoicePurpose, InvoiceStatus } from '../@types/invoice'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { PeeringAccess, PeeringPayment, PeeringPaymentStatus, PeeringTermSnapshot } from '../@types/peering'
import { IInvoiceRepository, INotificationOutboxRepository, IPeeringPaymentRepository } from '../@types/repositories'
import { IPaymentsService, IPeeringBillingService } from '../@types/services'
import { Settings } from '../@types/settings'
import { Transaction } from '../database/transaction'
import { createLogger } from '../factories/logger-factory'
import {
  InvalidPeeringTermError,
  PEERING_RECHECK_COOLDOWN_SECONDS,
  PEERING_REISSUE_COOLDOWN_SECONDS,
  PeeringInvoiceCooldownError,
  peeringInvoiceDescription,
  resolvePaidPeeringTerm,
} from '../utils/peering-billing'

const logger = createLogger('peering-billing-service')

const isExpiredAt = (invoice: Invoice, now: Date): boolean =>
  invoice.expiresAt instanceof Date && invoice.expiresAt.getTime() <= now.getTime()

export class PeeringBillingService implements IPeeringBillingService {
  public constructor(
    private readonly dbClient: DatabaseClient,
    private readonly peeringPaymentRepository: IPeeringPaymentRepository,
    private readonly invoiceRepository: IInvoiceRepository,
    private readonly paymentsService: IPaymentsService,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
    private readonly settings: () => Settings,
  ) {}

  public async getAccess(peerPubkey: Pubkey, options: { now?: Date; recheck?: boolean } = {}): Promise<PeeringAccess> {
    const now = options.now ?? new Date()
    let term: PeeringTermSnapshot | undefined

    try {
      term = resolvePaidPeeringTerm(this.settings())
    } catch (error) {
      logger.error('invalid paid peering term for %s: %o', peerPubkey, error)
      return {
        allowed: false,
        status: 'unconfigured',
        reason: error instanceof InvalidPeeringTermError ? error.message : 'invalid peering term',
      }
    }

    // An empty/zero term list means settlement-free peering.
    if (!term) {
      return { allowed: true, status: 'free' }
    }

    let payment = await this.peeringPaymentRepository.findByPeer(peerPubkey)
    let access = this.accessFrom(payment, now)

    if (!access.allowed && options.recheck) {
      const settled = await this.recheckPendingInvoice(peerPubkey, now)
      if (settled) {
        payment = await this.peeringPaymentRepository.findByPeer(peerPubkey)
        access = this.accessFrom(payment, now)
      }
    }

    return access
  }

  private accessFrom(payment: PeeringPayment | undefined, now: Date): PeeringAccess {
    if (!payment) {
      return {
        allowed: false,
        status: PeeringPaymentStatus.UNPAID,
        reason: 'no peering invoice has been issued yet',
      }
    }

    const running = payment.periodEnd instanceof Date && payment.periodEnd.getTime() > now.getTime()
    const payingStatus =
      payment.status === PeeringPaymentStatus.ACTIVE || payment.status === PeeringPaymentStatus.RENEWAL_PENDING

    if (running && payingStatus) {
      return {
        allowed: true,
        status: payment.status,
        periodEnd: payment.periodEnd,
      }
    }

    return {
      allowed: false,
      status: payment.status,
      periodEnd: payment.periodEnd,
      reason:
        payment.status === PeeringPaymentStatus.LAPSED
          ? 'peering access lapsed; request a new invoice'
          : 'peering payment required; request the kind 402 peering invoice',
    }
  }

  public async ensureInvoice(
    peerPubkey: Pubkey,
    options: { now?: Date; renewal?: boolean } = {},
  ): Promise<Invoice | undefined> {
    let term: PeeringTermSnapshot | undefined
    try {
      term = resolvePaidPeeringTerm(this.settings())
    } catch (error) {
      logger.error('unable to resolve paid peering term for %s: %o', peerPubkey, error)
      throw error
    }

    if (!term) {
      return undefined
    }

    if (this.settings().payments?.enabled !== true) {
      throw new Error('paid peering requires payments to be enabled')
    }

    const now = options.now ?? new Date()

    // Check the open invoice before retiring a locally expired one. The processor
    // may have accepted payment just before expiry, especially without webhooks.
    const settled = await this.recheckPendingInvoice(peerPubkey, now, true)
    if (settled) {
      const payment = await this.peeringPaymentRepository.findByPeer(peerPubkey)
      const settledInvoiceId = payment?.lastSettledInvoiceId
      if (settledInvoiceId) {
        const settledInvoice = await this.invoiceRepository.findById(settledInvoiceId)
        if (settledInvoice) {
          try {
            await this.paymentsService.ensurePeeringInvoiceNotification(settledInvoice)
          } catch (error) {
            logger.error('unable to publish settled peering invoice %s: %o', settledInvoice.id, error)
          }
          return settledInvoice
        }
      }

      return undefined
    }

    const transaction = new Transaction(this.dbClient)
    let invoice: Invoice | undefined

    await transaction.begin()
    try {
      await this.peeringPaymentRepository.ensureRow(peerPubkey, transaction.transaction)
      const payment = await this.peeringPaymentRepository.lockByPeer(peerPubkey, transaction.transaction)
      if (!payment) {
        throw new Error(`Unable to lock peering payment row for ${peerPubkey}`)
      }

      const running = payment.periodEnd instanceof Date && payment.periodEnd.getTime() > now.getTime()

      // Any open invoice is returned first, even one issued before the period ended:
      // it is still payable and creating a second one would charge the peer twice.
      const openInvoice = await this.findOpenInvoice(payment, now, transaction.transaction)
      if (openInvoice) {
        invoice = openInvoice
      } else {
        // findOpenInvoice clears pointers to invoices it retired. Re-read the locked row
        // so the new invoice is written against those cleared pointers, not stale ones.
        const current =
          (await this.peeringPaymentRepository.lockByPeer(peerPubkey, transaction.transaction)) ?? payment
        const renewal = options.renewal === true || running
        const created = await this.paymentsService.createPeeringInvoice(
          peerPubkey,
          term.amountMsats,
          peeringInvoiceDescription(this.settings(), peerPubkey, term),
          term.periodSeconds,
          transaction.transaction,
        )

        const next: PeeringPayment = {
          ...current,
          status: renewal ? PeeringPaymentStatus.RENEWAL_PENDING : PeeringPaymentStatus.INVOICED,
          currentInvoiceId: renewal ? (current.currentInvoiceId ?? null) : created.id,
          renewalInvoiceId: renewal ? created.id : null,
          termAmountMsats: term.amountMsats,
          termPeriodSeconds: term.periodSeconds,
          lastError: null,
        }

        await this.peeringPaymentRepository.save(next, transaction.transaction)
        invoice = created
      }

      await transaction.commit()
    } catch (error) {
      await transaction.rollback()
      logger.error('unable to ensure peering invoice for %s: %o', peerPubkey, error)
      throw error
    }

    // Publishing after the commit avoids advertising an invoice the database did
    // not accept. A failure here leaves the row intact; the next request republishes it.
    if (invoice) {
      try {
        await this.paymentsService.ensurePeeringInvoiceNotification(invoice)
      } catch (error) {
        logger.error('unable to publish peering invoice %s: %o', invoice.id, error)
      }
    }

    return invoice
  }

  private async findOpenInvoice(
    payment: PeeringPayment,
    now: Date,
    client: DatabaseClient,
  ): Promise<Invoice | undefined> {
    const candidates = [payment.renewalInvoiceId, payment.currentInvoiceId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    )

    let expired: Invoice | undefined
    for (const id of candidates) {
      const invoice = await this.invoiceRepository.findById(id, client)
      if (!invoice) {
        continue
      }

      if (invoice.status === InvoiceStatus.PENDING && !isExpiredAt(invoice, now)) {
        return invoice
      }

      if (invoice.status === InvoiceStatus.PENDING && isExpiredAt(invoice, now)) {
        expired = invoice
        await this.invoiceRepository.updateStatus({ id: invoice.id, status: InvoiceStatus.EXPIRED }, client)
        await this.enqueueFailed(invoice, 'expired', client)

        // Clear the pointer immediately, even if the other candidate is still usable.
        payment.currentInvoiceId = payment.currentInvoiceId === invoice.id ? null : payment.currentInvoiceId
        payment.renewalInvoiceId = payment.renewalInvoiceId === invoice.id ? null : payment.renewalInvoiceId
        await this.peeringPaymentRepository.save(payment, client)
      }
    }

    if (expired) {
      // The peer just let the invoice expire. Do not let it mint another one in a loop.
      const expiredAt = expired.expiresAt ?? payment.updatedAt
      const elapsedSeconds = Math.floor((now.getTime() - expiredAt.getTime()) / 1000)
      if (elapsedSeconds >= 0 && elapsedSeconds < PEERING_REISSUE_COOLDOWN_SECONDS) {
        throw new PeeringInvoiceCooldownError(PEERING_REISSUE_COOLDOWN_SECONDS - elapsedSeconds)
      }
    }

    return undefined
  }

  public async recheckPendingInvoice(peerPubkey: Pubkey, now = new Date(), force = false): Promise<boolean> {
    const payment = await this.peeringPaymentRepository.findByPeer(peerPubkey)
    const invoiceId = payment?.renewalInvoiceId ?? payment?.currentInvoiceId
    if (!payment || !invoiceId) {
      return false
    }

    if (
      !force &&
      payment.lastCheckedAt instanceof Date &&
      now.getTime() - payment.lastCheckedAt.getTime() < PEERING_RECHECK_COOLDOWN_SECONDS * 1000
    ) {
      return false
    }

    const invoice = await this.invoiceRepository.findById(invoiceId)
    // A locally expired invoice can still have been paid before its expiry. Ask the
    // processor before retiring it; LNURL and NWC rely on polling for settlement.
    if (!invoice || invoice.status !== InvoiceStatus.PENDING) {
      return false
    }

    try {
      const updated = await this.paymentsService.getInvoiceFromPaymentsProcessor(invoice)
      if (updated.status === InvoiceStatus.COMPLETED && updated.confirmedAt) {
        await this.paymentsService.confirmInvoice({
          ...invoice,
          ...updated,
          amountPaid: typeof updated.amountPaid === 'bigint' ? updated.amountPaid : invoice.amountRequested,
        })
        return true
      }

      // Update only the check columns. The processor call yields, and a webhook may
      // have settled this peer in the meantime; saving the old row would undo it.
      await this.peeringPaymentRepository.recordCheck(
        peerPubkey,
        now,
        updated.status ? `processor status: ${updated.status}` : null,
      )
      return false
    } catch (error) {
      logger.error('unable to recheck peering invoice %s: %o', invoiceId, error)
      await this.peeringPaymentRepository.recordCheck(
        peerPubkey,
        now,
        error instanceof Error ? error.message : 'processor check failed',
      )
      return false
    }
  }

  private async enqueueFailed(invoice: Invoice, reason: string, client?: DatabaseClient): Promise<void> {
    try {
      await this.notificationOutboxRepository.enqueue(
        OperatorNotificationEventType.PEERING_INVOICE_FAILED,
        {
          invoiceId: invoice.id,
          pubkey: invoice.pubkey,
          reason,
        },
        client,
      )
    } catch (error) {
      logger.error('unable to enqueue peering invoice failure for %s: %o', invoice.id, error)
    }
  }

}
