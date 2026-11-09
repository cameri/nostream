import { andThen, otherwise, pipe } from 'ramda'
import { broadcastEvent, getPublicKey, getRelayPrivateKey, identifyEvent, signEvent } from '../utils/event'
import { DatabaseClient, DatabaseTransaction, Pubkey, Tag } from '../@types/base'
import { FeeSchedule, Settings } from '../@types/settings'
import {
  IEventRepository,
  IInvoiceRepository,
  INotificationOutboxRepository,
  IPeeringPaymentRepository,
  IUserRepository,
  IUserSubscriptionRepository,
} from '../@types/repositories'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { Invoice, InvoicePurpose, InvoiceStatus, InvoiceUnit } from '../@types/invoice'

import { Event, ExpiringEvent, UnidentifiedEvent } from '../@types/event'
import { EventExpirationTimeMetadataKey, EventKinds, EventTags } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { IPaymentsProcessor } from '../@types/clients'
import { IPaymentsService } from '../@types/services'
import { PeeringPaymentStatus } from '../@types/peering'
import { Transaction } from '../database/transaction'
import { applyPayment, findSubscriptionPlan } from '../utils/subscription'
import { resolveInvoiceExpiry } from '../utils/invoice'
import { PEERING_INVOICE_TAG, peeringPeriodEnd } from '../utils/peering-billing'

const logger = createLogger('payments-service')

/** Invoices per maintenance pass. Small because each one is a processor round trip. */
export const PENDING_INVOICE_PAGE_SIZE = 10

export class PaymentsService implements IPaymentsService {
  public constructor(
    private readonly dbClient: DatabaseClient,
    private readonly paymentsProcessor: IPaymentsProcessor,
    private readonly userRepository: IUserRepository,
    private readonly invoiceRepository: IInvoiceRepository,
    private readonly eventRepository: IEventRepository,
    private readonly settings: () => Settings,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
    private readonly userSubscriptionRepository?: IUserSubscriptionRepository,
    private readonly peeringPaymentRepository?: IPeeringPaymentRepository,
  ) {}

  public async getPendingInvoices(offset = 0): Promise<Invoice[]> {
    logger('get pending invoices from offset %d', offset)
    try {
      return await this.invoiceRepository.findPendingInvoices(offset, PENDING_INVOICE_PAGE_SIZE)
    } catch (error) {
      logger.error('Unable to get pending invoices.', error)

      throw error
    }
  }

  public async getInvoiceFromPaymentsProcessor(invoice: Invoice | string): Promise<Partial<Invoice>> {
    try {
      return await this.paymentsProcessor.getInvoice(
        typeof invoice === 'string' || invoice?.verifyURL ? invoice : invoice.id,
      )
    } catch (error) {
      logger.error('Unable to get invoice from payments processor. Reason:', error)

      throw error
    }
  }

  public async createInvoice(pubkey: Pubkey, amount: bigint, description: string, planId?: string): Promise<Invoice> {
    logger('create invoice for %s for %s: %s', pubkey, amount.toString(), description)
    const transaction = new Transaction(this.dbClient)

    try {
      await transaction.begin()

      await this.userRepository.upsert({ pubkey }, transaction.transaction)

      const invoiceResponse = await this.paymentsProcessor.createInvoice({
        amount,
        description,
        requestId: pubkey,
      })

      const date = new Date()
      const expiresAt = resolveInvoiceExpiry(
        invoiceResponse.expiresAt,
        date,
        this.settings()?.payments?.invoiceExpirySeconds,
      )

      await this.invoiceRepository.upsert(
        {
          id: invoiceResponse.id,
          pubkey,
          bolt11: invoiceResponse.bolt11,
          amountRequested: invoiceResponse.amountRequested,
          description: invoiceResponse.description,
          unit: invoiceResponse.unit,
          status: invoiceResponse.status,
          expiresAt,
          updatedAt: date,
          createdAt: date,
          verifyURL: invoiceResponse.verifyURL,
          purpose: planId ? InvoicePurpose.SUBSCRIPTION : InvoicePurpose.ADMISSION,
          planId,
        },
        transaction.transaction,
      )

      await this.notificationOutboxRepository.enqueue(
        OperatorNotificationEventType.ADMISSION_INVOICE_CREATED,
        {
          invoiceId: invoiceResponse.id,
          pubkey,
          amountRequested: invoiceResponse.amountRequested.toString(),
          unit: invoiceResponse.unit,
        },
        transaction.transaction,
      )

      await transaction.commit()

      return {
        id: invoiceResponse.id,
        pubkey,
        bolt11: invoiceResponse.bolt11,
        amountRequested: invoiceResponse.amountRequested,
        unit: invoiceResponse.unit,
        status: invoiceResponse.status,
        description,
        expiresAt,
        updatedAt: date,
        createdAt: invoiceResponse.createdAt,
        verifyURL: invoiceResponse.verifyURL,
        purpose: planId ? InvoicePurpose.SUBSCRIPTION : InvoicePurpose.ADMISSION,
        planId,
      }
    } catch (error) {
      await transaction.rollback()
      logger.error('Unable to create invoice:', error)

      throw error
    }
  }

  /**
   * Creates a peering invoice without touching the user table or the admission
   * notifications. The caller may already hold a transaction (the billing
   * service locks the peer row before asking the processor), in which case this
   * method joins it instead of opening a nested one.
   */
  public async createPeeringInvoice(
    pubkey: Pubkey,
    amountMsats: bigint,
    description: string,
    termPeriodSeconds: number,
    client?: DatabaseTransaction,
  ): Promise<Invoice> {
    logger('create peering invoice for %s for %s msats', pubkey, amountMsats.toString())

    const transaction = client ? undefined : new Transaction(this.dbClient)
    if (transaction) {
      await transaction.begin()
    }
    const db = client ?? transaction!.transaction

    try {
      const invoiceResponse = await this.paymentsProcessor.createInvoice({
        amount: amountMsats,
        description,
        requestId: pubkey,
      })

      const date = new Date()
      const expiresAt = resolveInvoiceExpiry(
        invoiceResponse.expiresAt,
        date,
        this.settings()?.payments?.invoiceExpirySeconds,
      )

      const invoice: Invoice = {
        id: invoiceResponse.id,
        pubkey,
        bolt11: invoiceResponse.bolt11,
        amountRequested: invoiceResponse.amountRequested,
        description: invoiceResponse.description,
        unit: invoiceResponse.unit,
        status: invoiceResponse.status,
        expiresAt,
        updatedAt: date,
        createdAt: date,
        verifyURL: invoiceResponse.verifyURL,
        purpose: InvoicePurpose.PEERING,
        planId: null,
        termAmountMsats: amountMsats,
        termPeriodSeconds,
      }

      await this.invoiceRepository.upsert(invoice, db)

      await this.notificationOutboxRepository.enqueue(
        OperatorNotificationEventType.PEERING_INVOICE_CREATED,
        {
          invoiceId: invoice.id,
          pubkey,
          amountRequested: invoice.amountRequested.toString(),
          unit: invoice.unit,
          termAmountMsats: amountMsats.toString(),
          termPeriodSeconds,
        },
        db,
      )

      if (transaction) {
        await transaction.commit()
      }

      return invoice
    } catch (error) {
      if (transaction) {
        await transaction.rollback()
      }
      logger.error('Unable to create peering invoice:', error)

      throw error
    }
  }

  public async updateInvoice(invoice: Partial<Invoice>): Promise<void> {
    logger('update invoice %s: %o', invoice.id, invoice)
    try {
      await this.invoiceRepository.updateStatus({
        id: invoice.id,
        status: invoice.status,
      })
    } catch (error) {
      logger.error('Unable to update invoice. Reason:', error)
      throw error
    }
  }

  public async updateInvoiceStatus(invoice: Pick<Invoice, 'id' | 'status'>): Promise<Invoice> {
    logger('update invoice %s: %o', invoice.id, invoice)
    try {
      return await this.invoiceRepository.updateStatus(invoice)
    } catch (error) {
      logger.error('Unable to update invoice. Reason:', error)
      throw error
    }
  }

  public async confirmInvoice(invoice: Invoice): Promise<void> {
    logger('confirm invoice %s: %O', invoice.id, invoice)

    const transaction = new Transaction(this.dbClient)

    try {
      if (!invoice.confirmedAt) {
        throw new Error('Invoice confirmation date is not set')
      }
      if (invoice.status !== InvoiceStatus.COMPLETED) {
        throw new Error(`Invoice is not complete: ${invoice.status}`)
      }

      if (typeof invoice.amountPaid !== 'bigint') {
        throw new Error(`Invoice paid amount is not set: ${invoice.amountPaid}`)
      }

      await transaction.begin()

      const currentSettings = this.settings()
      // The callbacks only pass what their processor reports, so the purpose, plan, unit and
      // whether the invoice was already confirmed come from the stored invoice. This read must
      // happen before confirmation and must not be gated on subscriptions: peering invoices
      // need it even when subscription plans are off.
      const stored = await this.invoiceRepository.findById(invoice.id, transaction.transaction)

      await this.invoiceRepository.confirmInvoice(
        invoice.id,
        invoice.amountPaid,
        invoice.confirmedAt,
        transaction.transaction,
      )

      let amountPaidMsat = invoice.amountPaid

      const unit = invoice.unit ?? stored?.unit
      if (unit === InvoiceUnit.SATS) {
        amountPaidMsat *= 1000n
      } else if (unit === InvoiceUnit.BTC) {
        amountPaidMsat *= 1000n * 100000000n
      }

      if (stored?.purpose === InvoicePurpose.PEERING) {
        // The stored row is read inside this transaction. Once an invoice is confirmed,
        // a redelivered older callback must not buy another period even if the peer has
        // since settled a newer invoice.
        if (stored.confirmedAt) {
          await transaction.commit()
          return
        }

        const result = await this.settlePeeringInvoice(invoice, stored, amountPaidMsat, transaction.transaction)

        if (result.duplicate) {
          await transaction.commit()
          return
        }

        await this.notificationOutboxRepository.enqueue(
          result.activated
            ? OperatorNotificationEventType.PEERING_INVOICE_PAID
            : OperatorNotificationEventType.PEERING_INVOICE_FAILED,
          {
            invoiceId: invoice.id,
            pubkey: invoice.pubkey,
            amountPaid: invoice.amountPaid.toString(),
            unit,
            confirmedAt: invoice.confirmedAt.toISOString(),
            reason: result.reason,
          },
          transaction.transaction,
        )

        await transaction.commit()
        return
      }

      const isApplicableFee = (feeSchedule: FeeSchedule) =>
        feeSchedule.enabled && !feeSchedule.whitelists?.pubkeys?.includes(invoice.pubkey)
      const admissionFeeSchedules = currentSettings.payments?.feeSchedules?.admission ?? []
      const admissionFeeAmount = admissionFeeSchedules.reduce((sum, feeSchedule) => {
        return sum + (isApplicableFee(feeSchedule) ? BigInt(feeSchedule.amount) : 0n)
      }, 0n)

      const plan = findSubscriptionPlan(currentSettings, invoice.planId ?? stored?.planId)

      if (plan && this.userSubscriptionRepository) {
        if (stored?.confirmedAt) {
          // A repeated callback must not grant another period.
          logger('invoice %s was already confirmed, not extending the subscription again', invoice.id)
        } else if (amountPaidMsat >= BigInt(plan.amount)) {
          const date = new Date()
          const existing = await this.userSubscriptionRepository.findByPubkey(invoice.pubkey, transaction.transaction)
          await this.userSubscriptionRepository.upsert(
            applyPayment(invoice.pubkey, existing, plan, date),
            transaction.transaction,
          )
          await this.userRepository.admitUser(invoice.pubkey, date, transaction.transaction)
        } else {
          logger('invoice %s paid %s msats, below plan %s price %s', invoice.id, amountPaidMsat, plan.id, plan.amount)
        }
      } else if (admissionFeeAmount > 0n && amountPaidMsat >= admissionFeeAmount) {
        const date = new Date()
        await this.userRepository.admitUser(invoice.pubkey, date, transaction.transaction)
      }

      await this.notificationOutboxRepository.enqueue(
        OperatorNotificationEventType.ADMISSION_INVOICE_PAID,
        {
          invoiceId: invoice.id,
          pubkey: invoice.pubkey,
          amountPaid: invoice.amountPaid.toString(),
          unit: invoice.unit,
          confirmedAt: invoice.confirmedAt.toISOString(),
        },
        transaction.transaction,
      )

      await transaction.commit()
    } catch (error) {
      logger.error('Unable to confirm invoice. Reason:', error)
      await transaction.rollback()

      throw error
    }
  }

  private async settlePeeringInvoice(
    invoice: Invoice,
    stored: Invoice,
    amountPaidMsat: bigint,
    client: DatabaseTransaction,
  ): Promise<{ activated: boolean; duplicate?: boolean; reason?: string }> {
    if (!this.peeringPaymentRepository) {
      throw new Error('Peering payment repository is not configured')
    }

    const termAmountMsats = stored.termAmountMsats ?? 0n
    const termPeriodSeconds = stored.termPeriodSeconds ?? 0

    if (termAmountMsats <= 0n || termPeriodSeconds <= 0) {
      throw new Error(`Peering invoice ${invoice.id} has no term snapshot`)
    }

    const payment = await this.peeringPaymentRepository.lockByPeer(invoice.pubkey, client)
    if (!payment) {
      throw new Error(`Peering payment row is missing for ${invoice.pubkey}`)
    }

    if (payment.lastSettledInvoiceId === invoice.id) {
      // A duplicate callback or a worker poll after the webhook: the period was already granted.
      return { activated: true, duplicate: true }
    }

    const confirmedAt = invoice.confirmedAt as Date

    if (amountPaidMsat < termAmountMsats) {
      logger(
        'peering invoice %s paid %s msats, below term %s msats',
        invoice.id,
        amountPaidMsat.toString(),
        termAmountMsats.toString(),
      )

      await this.peeringPaymentRepository.save(
        {
          ...payment,
          lastCheckedAt: confirmedAt,
          lastError: `underpaid: received ${amountPaidMsat.toString()} of ${termAmountMsats.toString()} msats`,
        },
        client,
      )

      return { activated: false, reason: 'underpaid' }
    }

    // Paying early extends from the current period end; paying after a lapse starts now.
    const stillRunning = payment.periodEnd instanceof Date && payment.periodEnd.getTime() > confirmedAt.getTime()
    const periodStart = stillRunning ? (payment.periodEnd as Date) : confirmedAt
    const periodEnd = peeringPeriodEnd(periodStart, termPeriodSeconds)

    await this.peeringPaymentRepository.save(
      {
        ...payment,
        status: PeeringPaymentStatus.ACTIVE,
        currentInvoiceId: null,
        renewalInvoiceId: null,
        periodStart,
        periodEnd,
        lastSettledInvoiceId: invoice.id,
        lastSettledAt: confirmedAt,
        lastCheckedAt: confirmedAt,
        lastError: null,
      },
      client,
    )

    // The invoice is the ledger entry for the period it bought; the peer row is the live window.
    await this.invoiceRepository.updatePeriod(invoice.id, periodStart, periodEnd, client)

    return { activated: true }
  }

  /**
   * A peer may have missed the original broadcast. Republish only when the
   * expiring kind 402 event is not already stored, so a re-request does not
   * create one event per poll.
   */
  public async ensurePeeringInvoiceNotification(invoice: Invoice): Promise<void> {
    const existing = await this.eventRepository.findByFilters(
      [
        {
          kinds: [EventKinds.INVOICE_UPDATE],
          '#i': [invoice.id],
          limit: 1,
        },
      ],
      { excludeDeleted: true },
    )

    if (existing.length > 0) {
      return
    }

    await this.sendPeeringInvoiceNotification(invoice)
  }

  /** Publishes the peering invoice as a signed, p-tagged kind 402 event. */
  public async sendPeeringInvoiceNotification(invoice: Invoice): Promise<void> {
    logger('peering invoice notification %s: %o', invoice.id, invoice)

    const periodSeconds = invoice.termPeriodSeconds ?? 0
    const days = periodSeconds > 0 ? Math.max(1, Math.round(periodSeconds / 86_400)) : 0
    const content = `Paid peering invoice: ${invoice.amountRequested.toString()} ${invoice.unit}${
      days ? ` for ${days} day(s)` : ''
    }`

    const expiration = invoice.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)

    const extraTags: Tag[] = [
      [EventTags.Tag, PEERING_INVOICE_TAG],
      [EventTags.Index, invoice.id],
    ]

    await this.publishInvoiceNotification(invoice, content, expiration, extraTags)
  }

  public async sendInvoiceUpdateNotification(invoice: Invoice): Promise<void> {
    logger('invoice updated notification %s: %o', invoice.id, invoice)

    let unit: string = invoice.unit
    let amount: bigint | undefined = invoice.amountPaid
    if (typeof amount === 'undefined') {
      const message = `Unable to notify user ${invoice.pubkey} for invoice ${invoice.id}`

      throw new Error(message)
    }

    if (invoice.unit === InvoiceUnit.MSATS) {
      amount /= 1000n
      unit = InvoiceUnit.SATS
    }

    const now = new Date()
    const expiration = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())

    await this.publishInvoiceNotification(invoice, `Invoice paid: ${amount.toString()} ${unit}`, expiration)
  }

  public async sendRenewalNotification(invoice: Invoice): Promise<void> {
    logger('subscription renewal notification %s: %o', invoice.id, invoice)

    let unit: string = invoice.unit
    let amount = invoice.amountRequested
    if (invoice.unit === InvoiceUnit.MSATS) {
      amount /= 1000n
      unit = InvoiceUnit.SATS
    }

    // The notice is only useful while the invoice can still be paid.
    const expiration = invoice.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000)

    await this.publishInvoiceNotification(invoice, `Subscription renewal due: ${amount.toString()} ${unit}`, expiration)
  }

  private async publishInvoiceNotification(
    invoice: Invoice,
    content: string,
    expiration: Date,
    extraTags: Tag[] = [],
  ): Promise<void> {
    const {
      info: { relay_url: relayUrl },
    } = this.settings()

    const relayPrivkey = getRelayPrivateKey(relayUrl)
    const relayPubkey = getPublicKey(relayPrivkey)

    const now = new Date()

    const unsignedInvoiceEvent: UnidentifiedEvent & Pick<ExpiringEvent, typeof EventExpirationTimeMetadataKey> = {
      pubkey: relayPubkey,
      kind: EventKinds.INVOICE_UPDATE,
      created_at: Math.floor(now.getTime() / 1000),
      content,
      tags: [
        [EventTags.Pubkey, invoice.pubkey],
        ...extraTags,
        [EventTags.Invoice, invoice.bolt11],
        [EventTags.Expiration, Math.floor(expiration.getTime() / 1000).toString()],
      ],
      [EventExpirationTimeMetadataKey]: expiration.getTime() / 1000,
    }

    const persistEvent = async (event: Event) => {
      await this.eventRepository.create(event)

      return event
    }

    const logError = (error: Error) => logger.error('Unable to send notification', error)

    await pipe(
      identifyEvent,
      andThen(signEvent(relayPrivkey)),
      andThen(persistEvent),
      andThen(broadcastEvent),
      otherwise(logError),
    )(unsignedInvoiceEvent)
  }
}
