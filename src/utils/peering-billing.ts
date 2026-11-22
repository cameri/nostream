import { PeeringAccess, PeeringTermSnapshot } from '../@types/peering'
import { PeeringTerm, Settings } from '../@types/settings'
import { SubscriptionFilter } from '../@types/subscription'
import { EventKinds } from '../constants/base'

/** Topic tag carried by every peering invoice notification. */
export const PEERING_INVOICE_TAG = 'peering'

/** How long before a paid period ends the relay offers its renewal. */
export const PEERING_RENEWAL_LEAD_SECONDS = 3 * 24 * 60 * 60

/**
 * Recovery refuses to release a PAYING attempt until it has been idle this
 * long, so a wallet lookup cannot predate the attempt's own submission.
 */
export const PEERING_PAYMENT_SETTLE_GRACE_SECONDS = 300

/** A peer that just let an invoice expire cannot immediately mint another one. */
export const PEERING_REISSUE_COOLDOWN_SECONDS = 15

/** Do not ask the processor about the same unpaid peer more often than this. */
export const PEERING_RECHECK_COOLDOWN_SECONDS = 30

/** NIP-01 rejection reason for a denied peering access check. */
export const peeringPaymentRequiredReason = (access: Pick<PeeringAccess, 'reason'>): string =>
  access.reason?.startsWith('payment-required:')
    ? access.reason
    : `payment-required: ${access.reason ?? 'peering payment required; request the kind 402 peering invoice'}`

const UNIT_MULTIPLIER: Record<string, bigint> = {
  msats: 1n,
  sats: 1000n,
  btc: 100_000_000_000n,
}

export class InvalidPeeringTermError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'InvalidPeeringTermError'
  }
}

export class PeeringInvoiceCooldownError extends Error {
  public constructor(public readonly retryAfterSeconds: number) {
    super(`peering invoice reissue is cooling down for ${retryAfterSeconds}s`)
    this.name = 'PeeringInvoiceCooldownError'
  }
}

const toMsats = (amount: number, unit: string): bigint | undefined => {
  const multiplier = UNIT_MULTIPLIER[unit.trim().toLowerCase()]
  if (!multiplier) {
    return undefined
  }

  return BigInt(amount) * multiplier
}

/** Converts an advertised or configured amount to msats, or undefined for an unknown unit. */
export const peeringAmountToMsats = (amount: number, unit: string): bigint | undefined => toMsats(amount, unit)

/**
 * Resolves the single paid term in a list. An empty list, or only zero-amount
 * terms, means settlement-free peering and returns undefined. Anything unsafe
 * throws instead of silently granting free access.
 */
export const resolvePeeringTerm = (terms: PeeringTerm[] | undefined): PeeringTermSnapshot | undefined => {
  let resolved: PeeringTermSnapshot | undefined

  for (const term of terms ?? []) {
    if (typeof term !== 'object' || term === null) {
      throw new InvalidPeeringTermError('peering term must be an object')
    }

    if (typeof term.amount !== 'number' || !Number.isSafeInteger(term.amount)) {
      throw new InvalidPeeringTermError('peering term amount must be a safe integer')
    }

    // Zero is the explicit settlement-free term. Every other malformed amount must
    // fail closed: returning undefined would grant free peering by accident.
    if (term.amount === 0) {
      continue
    }

    if (term.amount < 0) {
      throw new InvalidPeeringTermError('peering term amount must not be negative')
    }

    const amountMsats = toMsats(term.amount, term.unit)
    if (amountMsats === undefined) {
      throw new InvalidPeeringTermError(`unsupported peering term unit "${term.unit}"; use msats, sats or btc`)
    }

    if (amountMsats <= 0n) {
      throw new InvalidPeeringTermError('peering term amount must be positive')
    }

    // The processor adapters take msats but several truncate to whole sats. A
    // sub-satoshi term would silently undercharge, so refuse it at the boundary.
    if (amountMsats % 1000n !== 0n) {
      throw new InvalidPeeringTermError('peering term amount must be a whole number of satoshis')
    }

    // Processor adapters convert msats to sats with Number(). Reject a term that
    // would cross Number.MAX_SAFE_INTEGER sats, or the invoice would be created
    // for a rounded amount that no longer matches the stored term.
    if (amountMsats / 1000n > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new InvalidPeeringTermError('peering term amount is too large for the payment processors')
    }

    if (!(typeof term.period === 'number' && Number.isSafeInteger(term.period) && term.period > 0)) {
      throw new InvalidPeeringTermError('peering term period must be a positive number of seconds')
    }

    if (resolved) {
      throw new InvalidPeeringTermError('multiple paid peering terms are not supported')
    }

    resolved = {
      amountMsats,
      periodSeconds: term.period,
    }
  }

  return resolved
}

/**
 * The paid term this relay sells. An empty list, or only zero-amount terms, means
 * settlement-free peering and returns undefined.
 */
export const resolvePaidPeeringTerm = (settings: Settings): PeeringTermSnapshot | undefined =>
  resolvePeeringTerm(settings.peering?.terms)

/** A configured buying budget, normalized for comparison with invoice amounts. */
export type PeeringBudgetSnapshot = PeeringTermSnapshot

export const resolvePeeringBudget = (budget: PeeringTerm | undefined): PeeringBudgetSnapshot | undefined =>
  budget === undefined ? undefined : resolvePeeringTerm([budget])

export const isPeeringInvoiceFilter = (filter: SubscriptionFilter, peerPubkey: string): boolean => {
  const kinds = filter.kinds
  const pubkeys = filter['#p']
  const topics = filter['#t']

  return (
    Array.isArray(kinds) &&
    kinds.length === 1 &&
    kinds[0] === EventKinds.INVOICE_UPDATE &&
    Array.isArray(pubkeys) &&
    pubkeys.includes(peerPubkey) &&
    Array.isArray(topics) &&
    topics.includes(PEERING_INVOICE_TAG)
  )
}

export const isPeeringInvoiceRequest = (filters: SubscriptionFilter[], peerPubkey: string): boolean =>
  filters.length > 0 && filters.every((filter) => isPeeringInvoiceFilter(filter, peerPubkey))

export const peeringPeriodEnd = (start: Date, periodSeconds: number): Date =>
  new Date(start.getTime() + periodSeconds * 1000)

/** Fixed, epoch-aligned budget window. Renewals inside it share one counter. */
export const peeringBudgetWindow = (
  now: Date,
  periodSeconds: number,
): { start: Date; end: Date } => {
  const periodMs = periodSeconds * 1000
  const startMs = Math.floor(now.getTime() / periodMs) * periodMs

  return {
    start: new Date(startMs),
    end: new Date(startMs + periodMs),
  }
}

export const peeringInvoiceDescription = (
  settings: Settings,
  peerPubkey: string,
  term: PeeringTermSnapshot,
): string => {
  const days = Math.max(1, Math.round(term.periodSeconds / 86_400))
  return `${settings.info.name} paid peering for ${peerPubkey.slice(0, 12)}…: ${term.amountMsats.toString()} msats for ${days} day(s)`
}

export const isPeeringAccessActive = (status: string, periodEnd: Date | null | undefined, now: Date): boolean =>
  (status === 'active' || status === 'renewal_pending') &&
  periodEnd instanceof Date &&
  periodEnd.getTime() > now.getTime()
