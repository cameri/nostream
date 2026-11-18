import { DatabaseClient, Pubkey } from '../@types/base'
import { PaymentsProcessorCannotPayError } from '../@types/clients'
import { Event } from '../@types/event'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import {
  PeeringAdvertisement,
  PeeringBudgetSummary,
  PeeringInvoice,
  PeeringInvoiceReason,
  PeeringInvoiceStatus,
} from '../@types/peering'
import { INotificationOutboxRepository, IPeeringInvoiceRepository } from '../@types/repositories'
import { IPaymentsService, IPeeringBuyerService } from '../@types/services'
import { PeeringPeer, Settings } from '../@types/settings'
import { EventKinds, EventTags } from '../constants/base'
import { Transaction } from '../database/transaction'
import { createLogger } from '../factories/logger-factory'
import { decodeBolt11 } from '../utils/bolt11'
import { getPublicKey, getRelayPrivateKey } from '../utils/event'
import { findConfiguredPeeringPeer, parsePeeringPeerPubkey } from '../utils/peering-auth'
import {
  PEERING_INVOICE_TAG,
  PeeringBudgetSnapshot,
  peeringBudgetWindow,
  resolvePeeringBudget,
  resolvePeeringTerm,
} from '../utils/peering-billing'

const logger = createLogger('peering-buyer-service')

const tagValues = (event: Event, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name && typeof tag[1] === 'string').map((tag) => tag[1])

const expirationDate = (event: Event): Date | undefined => {
  const value = tagValues(event, EventTags.Expiration)[0]
  if (!value) {
    return undefined
  }

  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined
}

const isInvoiceEventFor = (event: Event, selfPubkey: string): boolean => {
  if (event.kind !== EventKinds.INVOICE_UPDATE) {
    return false
  }

  return tagValues(event, EventTags.Pubkey).includes(selfPubkey) &&
    tagValues(event, EventTags.Tag).includes(PEERING_INVOICE_TAG) &&
    tagValues(event, EventTags.Invoice).length > 0
}

interface ReserveResult {
  reserved: boolean
  peerBudget?: PeeringBudgetSnapshot
  globalBudget?: PeeringBudgetSnapshot
  peerWindow?: { start: Date; end: Date }
  globalWindow?: { start: Date; end: Date }
}

export class PeeringBuyerService implements IPeeringBuyerService {
  public constructor(
    private readonly dbClient: DatabaseClient,
    private readonly invoiceRepository: IPeeringInvoiceRepository,
    private readonly paymentsService: IPaymentsService,
    private readonly notificationOutboxRepository: INotificationOutboxRepository,
    private readonly settings: () => Settings,
    private readonly selfPubkey: () => string = () =>
      getPublicKey(getRelayPrivateKey(settings().info?.relay_url)),
  ) {}

  public async handleInvoice(
    peer: PeeringPeer,
    advertisement: PeeringAdvertisement,
    event: Event,
    now = new Date(),
  ): Promise<PeeringInvoice> {
    const configured = findConfiguredPeeringPeer(this.settings(), event.pubkey)
    const peerPubkey = parsePeeringPeerPubkey(peer.pubkey) ?? peer.pubkey.toLowerCase()
    const base = this.baseInvoice(peerPubkey, event)
    const stored = await this.invoiceRepository.insertIfNew({
      ...base,
      status: PeeringInvoiceStatus.RECEIVED,
      reason: null,
    })
    const invoice = stored.invoice

    if (!stored.inserted) {
      return invoice
    }

    if (event.pubkey.toLowerCase() !== peerPubkey || !configured) {
      return this.hold(invoice, PeeringInvoiceReason.UNKNOWN_PEER)
    }

    if (!isInvoiceEventFor(event, this.selfPubkey())) {
      return this.hold(invoice, PeeringInvoiceReason.INVALID_INVOICE)
    }

    const expiresAt = expirationDate(event)
    if (expiresAt && expiresAt.getTime() <= now.getTime()) {
      return this.hold({ ...invoice, expiresAt }, PeeringInvoiceReason.EXPIRED)
    }

    let expected
    try {
      expected = resolvePeeringTerm(advertisement.terms)
    } catch (error) {
      logger('peer %s advertised an invalid term: %o', peerPubkey, error)
      return this.hold(invoice, PeeringInvoiceReason.AMOUNT_MISMATCH)
    }

    if (!expected || expected.amountMsats !== invoice.amountMsats) {
      return this.hold(invoice, PeeringInvoiceReason.AMOUNT_MISMATCH)
    }

    const autoPay = this.settings().peering?.autoPay
    if (autoPay?.enabled !== true) {
      return this.hold({ ...invoice, termPeriodSeconds: expected.periodSeconds }, PeeringInvoiceReason.AUTO_PAY_DISABLED)
    }

    const peerBudget = resolvePeeringBudget(peer.budget)
    if (!peerBudget) {
      return this.hold(
        { ...invoice, termPeriodSeconds: expected.periodSeconds },
        PeeringInvoiceReason.BUDGET_NOT_CONFIGURED,
      )
    }

    return this.pay(invoice, peerBudget, expected.periodSeconds, expiresAt, true, now)
  }

  public async approve(paymentHash: string, now = new Date()): Promise<PeeringInvoice> {
    const invoice = await this.invoiceRepository.findByHash(paymentHash)
    if (!invoice) {
      throw new Error(`peering invoice ${paymentHash} not found`)
    }

    const claimed = await this.invoiceRepository.claim(
      paymentHash,
      [PeeringInvoiceStatus.HELD, PeeringInvoiceStatus.FAILED],
      PeeringInvoiceStatus.PAYING,
    )
    if (!claimed) {
      throw new Error(`peering invoice ${paymentHash} is not awaiting approval`)
    }

    const peer = findConfiguredPeeringPeer(this.settings(), invoice.peerPubkey)
    const peerBudget = resolvePeeringBudget(peer?.budget)

    return this.settle(claimed, peerBudget, claimed.termPeriodSeconds ?? null, false, now)
  }

  public async reject(paymentHash: string): Promise<PeeringInvoice> {
    const claimed = await this.invoiceRepository.claim(
      paymentHash,
      [PeeringInvoiceStatus.HELD, PeeringInvoiceStatus.FAILED],
      PeeringInvoiceStatus.REJECTED,
    )
    if (!claimed) {
      throw new Error(`peering invoice ${paymentHash} is not awaiting a decision`)
    }

    return claimed
  }

  public list(statuses?: PeeringInvoiceStatus[], limit = 100): Promise<PeeringInvoice[]> {
    return this.invoiceRepository.list(statuses, limit)
  }

  public async budgetSummary(now = new Date()): Promise<PeeringBudgetSummary[]> {
    const [usage, invoices] = await Promise.all([
      this.invoiceRepository.listBudgets(),
      this.invoiceRepository.list(undefined, 1000),
    ])
    const byScope = new Map(usage.map((entry) => [`${entry.scope}|${entry.periodStart.toISOString()}`, entry]))
    const summaries: PeeringBudgetSummary[] = []

    const summarize = (
      scope: 'peer' | 'global',
      peerPubkey: string | undefined,
      budget: { amount: number; unit: string; period: number } | undefined,
    ) => {
      const resolved = resolvePeeringBudget(budget)
      if (!resolved) {
        return
      }

      const window = peeringBudgetWindow(now, resolved.periodSeconds)
      const key = `${scope === 'global' ? 'global' : `peer:${peerPubkey!.toLowerCase()}`}|${window.start.toISOString()}`
      const spent = byScope.get(key)?.spentMsats ?? 0n
      const relevant = invoices.filter(
        (invoice) =>
          invoice.createdAt >= window.start &&
          invoice.createdAt < window.end &&
          (scope === 'global' || invoice.peerPubkey.toLowerCase() === peerPubkey!.toLowerCase()),
      )

      summaries.push({
        scope,
        ...(peerPubkey ? { peerPubkey } : {}),
        periodStart: window.start,
        periodEnd: window.end,
        limitMsats: resolved.amountMsats,
        spentMsats: spent,
        remainingMsats: resolved.amountMsats > spent ? resolved.amountMsats - spent : 0n,
        received: relevant.length,
        paid: relevant.filter((invoice) => invoice.status === PeeringInvoiceStatus.PAID).length,
        held: relevant.filter(
          (invoice) =>
            invoice.status === PeeringInvoiceStatus.HELD || invoice.status === PeeringInvoiceStatus.FAILED,
        ).length,
      })
    }

    summarize('global', undefined, this.settings().peering?.autoPay?.globalBudget)
    for (const peer of this.settings().peering?.peers ?? []) {
      if (peer.enabled === false) {
        continue
      }
      summarize('peer', parsePeeringPeerPubkey(peer.pubkey) ?? peer.pubkey, peer.budget)
    }

    return summaries.sort((left, right) => (left.peerPubkey ?? '').localeCompare(right.peerPubkey ?? ''))
  }

  private baseInvoice(peerPubkey: Pubkey, event: Event): PeeringInvoice {
    const bolt11 = tagValues(event, EventTags.Invoice)[0]
    const decoded = decodeBolt11(bolt11)
    const now = new Date()

    return {
      paymentHash: decoded.paymentHash,
      eventId: event.id,
      peerPubkey,
      bolt11,
      amountMsats: decoded.amountMsats,
      status: PeeringInvoiceStatus.RECEIVED,
      reason: null,
      autoPaid: false,
      budgetPeriodStart: null,
      budgetPeriodEnd: null,
      termPeriodSeconds: null,
      expiresAt: expirationDate(event) ?? null,
      seenCount: 1,
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  private async hold(invoice: PeeringInvoice, reason: PeeringInvoiceReason): Promise<PeeringInvoice> {
    const updated = await this.invoiceRepository.update(invoice.paymentHash, {
      status: PeeringInvoiceStatus.HELD,
      reason,
      autoPaid: false,
    })

    await this.notify(OperatorNotificationEventType.PEERING_INVOICE_FAILED, {
      paymentHash: invoice.paymentHash,
      peerPubkey: invoice.peerPubkey,
      amountMsats: invoice.amountMsats.toString(),
      reason,
    })

    return updated ?? { ...invoice, status: PeeringInvoiceStatus.HELD, reason }
  }

  private async pay(
    invoice: PeeringInvoice,
    peerBudget: PeeringBudgetSnapshot,
    termPeriodSeconds: number,
    expiresAt: Date | undefined,
    auto: boolean,
    now: Date,
  ): Promise<PeeringInvoice> {
    const claimed = await this.invoiceRepository.claim(
      invoice.paymentHash,
      [PeeringInvoiceStatus.RECEIVED],
      PeeringInvoiceStatus.PAYING,
    )
    if (!claimed) {
      return (await this.invoiceRepository.findByHash(invoice.paymentHash)) ?? invoice
    }

    const reservation = await this.reserve(claimed, peerBudget, auto, now)
    if (!reservation.reserved) {
      return this.hold(
        { ...claimed, termPeriodSeconds },
        PeeringInvoiceReason.BUDGET_EXCEEDED,
      )
    }

    return this.settle(
      { ...claimed, termPeriodSeconds, expiresAt: expiresAt ?? claimed.expiresAt ?? null },
      peerBudget,
      termPeriodSeconds,
      auto,
      now,
      reservation,
    )
  }

  private async settle(
    invoice: PeeringInvoice,
    peerBudget: PeeringBudgetSnapshot | undefined,
    termPeriodSeconds: number | null,
    auto: boolean,
    now: Date,
    reservation?: ReserveResult,
  ): Promise<PeeringInvoice> {
    const current = reservation ?? (await this.reserve(invoice, peerBudget, auto, now))
    if (!current.reserved && auto) {
      return this.hold(invoice, PeeringInvoiceReason.BUDGET_EXCEEDED)
    }

    try {
      const paidHash = await this.paymentsService.payInvoice(invoice.bolt11)
      if (paidHash.toLowerCase() !== invoice.paymentHash.toLowerCase()) {
        throw new Error(`processor paid ${paidHash}, expected ${invoice.paymentHash}`)
      }

      const paid = await this.invoiceRepository.update(invoice.paymentHash, {
        status: PeeringInvoiceStatus.PAID,
        reason: null,
        autoPaid: auto,
        paidAt: now,
        termPeriodSeconds,
        ...(current.peerWindow ? { budgetPeriodStart: current.peerWindow.start, budgetPeriodEnd: current.peerWindow.end } : {}),
      })

      await this.notify(OperatorNotificationEventType.PEERING_INVOICE_PAID, {
        paymentHash: invoice.paymentHash,
        peerPubkey: invoice.peerPubkey,
        amountMsats: invoice.amountMsats.toString(),
        autoPaid: auto,
      })

      return paid ?? { ...invoice, status: PeeringInvoiceStatus.PAID, reason: null, autoPaid: auto, paidAt: now }
    } catch (error) {
      logger('unable to pay peering invoice %s: %o', invoice.paymentHash, error)
      const reason =
        error instanceof PaymentsProcessorCannotPayError
          ? PeeringInvoiceReason.UNSUPPORTED_PROCESSOR
          : PeeringInvoiceReason.PAYMENT_FAILED
      await this.release(invoice, current, now)
      const held = await this.invoiceRepository.update(invoice.paymentHash, {
        status: PeeringInvoiceStatus.HELD,
        reason,
        autoPaid: false,
      })

      await this.notify(OperatorNotificationEventType.PEERING_INVOICE_FAILED, {
        paymentHash: invoice.paymentHash,
        peerPubkey: invoice.peerPubkey,
        amountMsats: invoice.amountMsats.toString(),
        reason,
      })

      return held ?? {
        ...invoice,
        status: PeeringInvoiceStatus.HELD,
        reason,
        autoPaid: false,
      }
    }
  }

  private async reserve(
    invoice: PeeringInvoice,
    peerBudget: PeeringBudgetSnapshot | undefined,
    auto: boolean,
    now: Date,
  ): Promise<ReserveResult> {
    if (!peerBudget) {
      return { reserved: false }
    }

    const globalBudget = resolvePeeringBudget(this.settings().peering?.autoPay?.globalBudget)
    const peerWindow = peeringBudgetWindow(now, peerBudget.periodSeconds)
    const globalWindow = globalBudget ? peeringBudgetWindow(now, globalBudget.periodSeconds) : undefined
    const transaction = new Transaction(this.dbClient)
    let started = false

    try {
      await transaction.begin()
      started = true

      const peerScope = `peer:${invoice.peerPubkey.toLowerCase()}`
      if (auto) {
        const peerSpent = await this.invoiceRepository.reserveBudget(
          peerScope,
          peerWindow.start,
          peerWindow.end,
          invoice.amountMsats,
          peerBudget.amountMsats,
          transaction.transaction,
        )
        if (peerSpent === undefined) {
          await transaction.rollback()
          return { reserved: false, peerBudget, peerWindow }
        }

        if (globalBudget && globalWindow) {
          const globalSpent = await this.invoiceRepository.reserveBudget(
            'global',
            globalWindow.start,
            globalWindow.end,
            invoice.amountMsats,
            globalBudget.amountMsats,
            transaction.transaction,
          )
          if (globalSpent === undefined) {
            await transaction.rollback()
            return { reserved: false, peerBudget, peerWindow, globalBudget, globalWindow }
          }
        }
      } else {
        await this.invoiceRepository.addBudgetSpend(
          peerScope,
          peerWindow.start,
          peerWindow.end,
          invoice.amountMsats,
          transaction.transaction,
        )
        if (globalBudget && globalWindow) {
          await this.invoiceRepository.addBudgetSpend(
            'global',
            globalWindow.start,
            globalWindow.end,
            invoice.amountMsats,
            transaction.transaction,
          )
        }
      }

      await transaction.commit()
      started = false

      return { reserved: true, peerBudget, peerWindow, globalBudget, globalWindow }
    } catch (error) {
      if (started) {
        await transaction.rollback()
      }
      logger('unable to reserve a peering budget for %s: %o', invoice.paymentHash, error)

      return { reserved: false, peerBudget, peerWindow, globalBudget, globalWindow }
    }
  }

  private async release(invoice: PeeringInvoice, reservation: ReserveResult, now: Date): Promise<void> {
    if (!reservation.reserved) {
      return
    }

    const transaction = new Transaction(this.dbClient)
    let started = false
    try {
      await transaction.begin()
      started = true
      if (reservation.peerWindow) {
        await this.invoiceRepository.releaseBudget(
          `peer:${invoice.peerPubkey.toLowerCase()}`,
          reservation.peerWindow.start,
          invoice.amountMsats,
          transaction.transaction,
        )
      }
      if (reservation.globalWindow) {
        await this.invoiceRepository.releaseBudget(
          'global',
          reservation.globalWindow.start,
          invoice.amountMsats,
          transaction.transaction,
        )
      }
      await transaction.commit()
      started = false
    } catch (error) {
      if (started) {
        await transaction.rollback()
      }
      logger('unable to release the peering budget for %s: %o', invoice.paymentHash, error)
    }
  }

  private async notify(type: OperatorNotificationEventType, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.notificationOutboxRepository.enqueue(type, payload)
    } catch (error) {
      logger('unable to enqueue %s: %o', type, error)
    }
  }
}
