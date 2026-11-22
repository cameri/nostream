import { PeeringPayment, PeeringPaymentStatus, PeeringPeerSyncState } from '../@types/peering'
import { Settings } from '../@types/settings'
import { parsePeeringPeerPubkey } from './peering-auth'
import { resolvePaidPeeringTerm } from './peering-billing'
import { PeeringRequestStats } from './peering-request-stats'
import { isPeeringSyncStateStale, PEERING_SYNC_STATE_STALE_AFTER_SECONDS } from './peering-sync-state'

export interface AdminPeeringBilling {
  status: PeeringPayment['status']
  periodStart?: Date | null
  periodEnd?: Date | null
  currentInvoiceId?: string | null
  renewalInvoiceId?: string | null
  termAmountMsats?: string | null
  termPeriodSeconds?: number | null
  lastSettledAt?: Date | null
  lastCheckedAt?: Date | null
  lastError?: string | null
}

export type AdminPeeringRelationship = 'active' | 'suspended' | 'lapsed' | 'unpaid' | 'free' | 'removed'

export interface AdminPeeringTerms {
  amountMsats: string
  periodSeconds: number
}

export interface AdminPeeringRow {
  pubkey: string
  relayUrl: string
  configured: boolean
  enabled: boolean
  stale: boolean
  relationship: AdminPeeringRelationship
  terms?: AdminPeeringTerms
  state?: PeeringPeerSyncState
  requests?: PeeringRequestStats
  billing?: AdminPeeringBilling
}

const toAdminBilling = (payment: PeeringPayment): AdminPeeringBilling => ({
  status: payment.status,
  periodStart: payment.periodStart,
  periodEnd: payment.periodEnd,
  currentInvoiceId: payment.currentInvoiceId,
  renewalInvoiceId: payment.renewalInvoiceId,
  termAmountMsats: typeof payment.termAmountMsats === 'bigint' ? payment.termAmountMsats.toString() : null,
  termPeriodSeconds: payment.termPeriodSeconds,
  lastSettledAt: payment.lastSettledAt,
  lastCheckedAt: payment.lastCheckedAt,
  lastError: payment.lastError,
})

const relationshipFor = (
  configured: boolean,
  enabled: boolean,
  billing: AdminPeeringBilling | undefined,
): AdminPeeringRelationship => {
  if (billing?.status === PeeringPaymentStatus.LAPSED) {
    return 'lapsed'
  }
  if (!configured) {
    return 'removed'
  }
  if (!enabled) {
    return 'suspended'
  }
  if (
    billing?.status === PeeringPaymentStatus.ACTIVE ||
    billing?.status === PeeringPaymentStatus.RENEWAL_PENDING
  ) {
    return 'active'
  }
  if (
    billing?.status === PeeringPaymentStatus.UNPAID ||
    billing?.status === PeeringPaymentStatus.INVOICED
  ) {
    return 'unpaid'
  }

  return 'free'
}

const termsFor = (billing: AdminPeeringBilling | undefined): AdminPeeringTerms | undefined =>
  billing?.termAmountMsats && billing.termPeriodSeconds
    ? { amountMsats: billing.termAmountMsats, periodSeconds: billing.termPeriodSeconds }
    : undefined

export const mergePeeringRows = (
  settings: Settings,
  states: PeeringPeerSyncState[],
  staleAfterSeconds = PEERING_SYNC_STATE_STALE_AFTER_SECONDS,
  requestStats: PeeringRequestStats[] = [],
  billing: PeeringPayment[] = [],
): AdminPeeringRow[] => {
  const statesByPubkey = new Map(states.map((state) => [state.pubkey.toLowerCase(), state]))
  const requestsByPubkey = new Map(requestStats.map((stats) => [stats.pubkey.toLowerCase(), stats]))
  const billingByPubkey = new Map(billing.map((payment) => [payment.peerPubkey.toLowerCase(), payment]))
  const paidTerm = resolvePaidPeeringTerm(settings)
  const configuredTerms: AdminPeeringTerms | undefined = paidTerm
    ? { amountMsats: paidTerm.amountMsats.toString(), periodSeconds: paidTerm.periodSeconds }
    : undefined
  const rows: AdminPeeringRow[] = []
  const matched = new Set<string>()

  for (const peer of settings.peering?.peers ?? []) {
    const pubkey = parsePeeringPeerPubkey(peer.pubkey) ?? peer.pubkey
    const normalized = pubkey.toLowerCase()
    const stored = statesByPubkey.get(normalized)
    const state = stored?.relayUrl === peer.relayUrl ? stored : undefined
    const enabled = peer.enabled !== false

    matched.add(normalized)
    const billing = billingByPubkey.get(normalized)
      ? toAdminBilling(billingByPubkey.get(normalized)!)
      : undefined
    const relationship =
      enabled && !billing && configuredTerms ? 'unpaid' : relationshipFor(true, enabled, billing)
    rows.push({
      pubkey,
      relayUrl: peer.relayUrl,
      configured: true,
      enabled,
      stale: enabled && (!state || isPeeringSyncStateStale(state.updatedAt, staleAfterSeconds)),
      relationship,
      terms: termsFor(billing) ?? configuredTerms,
      state,
      requests: requestsByPubkey.get(normalized),
      billing,
    })
  }

  // A peer removed from settings can still have a stored state row until its TTL
  // expires. Showing it makes a stale relationship obvious instead of hiding it.
  for (const state of states) {
    if (matched.has(state.pubkey.toLowerCase())) {
      continue
    }

    const billing = billingByPubkey.get(state.pubkey.toLowerCase())
      ? toAdminBilling(billingByPubkey.get(state.pubkey.toLowerCase())!)
      : undefined
    rows.push({
      pubkey: state.pubkey,
      relayUrl: state.relayUrl,
      configured: false,
      enabled: false,
      stale: isPeeringSyncStateStale(state.updatedAt, staleAfterSeconds),
      relationship: relationshipFor(false, false, billing),
      terms: termsFor(billing),
      state,
      requests: requestsByPubkey.get(state.pubkey.toLowerCase()),
      billing,
    })
  }

  // A billing row can outlive the peer's sync state; show it so a removed peer with
  // an unpaid or active period is not invisible to the operator.
  for (const payment of billing) {
    if (matched.has(payment.peerPubkey.toLowerCase())) {
      continue
    }
    if (rows.some((row) => row.pubkey.toLowerCase() === payment.peerPubkey.toLowerCase())) {
      continue
    }

    const billing = toAdminBilling(payment)
    rows.push({
      pubkey: payment.peerPubkey,
      relayUrl: '',
      configured: false,
      enabled: false,
      stale: true,
      relationship: relationshipFor(false, false, billing),
      terms: termsFor(billing),
      billing,
    })
  }

  return rows.sort((left, right) => {
    const relayCompare = left.relayUrl.localeCompare(right.relayUrl)
    return relayCompare !== 0 ? relayCompare : left.pubkey.localeCompare(right.pubkey)
  })
}
