import { PeeringTermSnapshot } from '../@types/peering'
import { Settings } from '../@types/settings'
import { SubscriptionFilter } from '../@types/subscription'
import { EventKinds } from '../constants/base'

/** Topic tag carried by every peering invoice notification. */
export const PEERING_INVOICE_TAG = 'peering'

/** How long before a paid period ends the relay offers its renewal. */
export const PEERING_RENEWAL_LEAD_SECONDS = 3 * 24 * 60 * 60

/** A peer that just let an invoice expire cannot immediately mint another one. */
export const PEERING_REISSUE_COOLDOWN_SECONDS = 15

/** Do not ask the processor about the same unpaid peer more often than this. */
export const PEERING_RECHECK_COOLDOWN_SECONDS = 30

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

/**
 * The paid term this relay sells. An empty list, or only zero-amount terms, means
 * settlement-free peering and returns undefined. A configured paid term that cannot
 * be charged safely throws instead of silently granting free access.
 */
export const resolvePaidPeeringTerm = (settings: Settings): PeeringTermSnapshot | undefined => {
  const terms = settings.peering?.terms ?? []

  for (const term of terms) {
    if (!(typeof term.amount === 'number' && Number.isSafeInteger(term.amount) && term.amount > 0)) {
      continue
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

    if (!(typeof term.period === 'number' && Number.isSafeInteger(term.period) && term.period > 0)) {
      throw new InvalidPeeringTermError('peering term period must be a positive number of seconds')
    }

    return {
      amountMsats,
      periodSeconds: term.period,
    }
  }

  return undefined
}

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
  filters.some((filter) => isPeeringInvoiceFilter(filter, peerPubkey))

export const peeringPeriodEnd = (start: Date, periodSeconds: number): Date =>
  new Date(start.getTime() + periodSeconds * 1000)

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
