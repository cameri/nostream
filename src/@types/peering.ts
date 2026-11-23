import { Pubkey } from './base'
import { PeeringOwnerAttestationPolicy, PeeringScope, PeeringTerm } from './settings'

/** One scope advertised by a peer in its NIP-11 `peering` section. */
export type AdvertisedPeeringScope = PeeringScope

export interface PeeringAdvertisement {
  enabled: boolean
  scopes: AdvertisedPeeringScope[]
  terms: PeeringTerm[]
  /** The relay key the peer advertises as `self`, when it publishes one. */
  self?: string
  /** How the peer treats owner attestation on incoming requests. */
  ownerAttestation?: PeeringOwnerAttestationPolicy
  /** NIP-13 bits the peer requires on a peering request. */
  minPowDifficulty?: number
  supportedNips: number[]
}

/** An owner-signed peering request, carried in an ephemeral kind 28937 event. */
export interface PeeringRequestPayload {
  relay_pubkey: string
  relay_url: string
  scopes: PeeringScope[]
  terms: PeeringTerm[]
  terms_hash: string
}

/** A relay-signed acceptance of one specific peering request. */
export interface PeeringAcceptancePayload {
  request_id: string
  relay_pubkey: string
  relay_url: string
  terms_hash: string
  accepted_at: number
}

/** The latest accepted owner attestation for one relay key. */
export interface PeeringAttestation {
  relayPubkey: Pubkey
  ownerPubkey: Pubkey
  relayUrl: string
  requestEventId: string
  scopes: PeeringScope[]
  terms: PeeringTerm[]
  termsHash: string
  powDifficulty: number
  acceptedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface DBPeeringAttestation {
  relay_pubkey: Buffer
  owner_pubkey: Buffer
  relay_url: string
  request_event_id: string
  scopes: unknown
  terms: unknown
  terms_hash: string
  pow_difficulty: number
  accepted_at: Date | null
  created_at: Date
  updated_at: Date
}

export type PeeringSyncStatus = 'idle' | 'connecting' | 'reconciling' | 'live' | 'error' | 'stopped'

export enum PeeringPaymentDirection {
  SELL = 'sell',
  BUY = 'buy',
}

export enum PeeringPaymentStatus {
  UNPAID = 'unpaid',
  INVOICED = 'invoiced',
  ACTIVE = 'active',
  RENEWAL_PENDING = 'renewal_pending',
  LAPSED = 'lapsed',
}

/** Billing state for one peer relationship in one direction. */
export interface PeeringPayment {
  peerPubkey: Pubkey
  direction: PeeringPaymentDirection
  status: PeeringPaymentStatus
  currentInvoiceId?: string | null
  renewalInvoiceId?: string | null
  periodStart?: Date | null
  periodEnd?: Date | null
  termAmountMsats?: bigint | null
  termPeriodSeconds?: number | null
  lastSettledInvoiceId?: string | null
  lastSettledAt?: Date | null
  lastCheckedAt?: Date | null
  lastError?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface DBPeeringPayment {
  peer_pubkey: Buffer
  direction: PeeringPaymentDirection
  status: PeeringPaymentStatus
  current_invoice_id: string | null
  renewal_invoice_id: string | null
  period_start: Date | null
  period_end: Date | null
  term_amount_msats: string | null
  term_period_seconds: number | null
  last_settled_invoice_id: string | null
  last_settled_at: Date | null
  last_checked_at: Date | null
  last_error: string | null
  created_at: Date
  updated_at: Date
}

export interface PeeringAccess {
  allowed: boolean
  status: PeeringPaymentStatus | 'free' | 'unconfigured'
  periodEnd?: Date | null
  reason?: string
}

/** A buying-side invoice received over the peer connection. */
export enum PeeringInvoiceStatus {
  RECEIVED = 'received',
  PAYING = 'paying',
  PAID = 'paid',
  HELD = 'held',
  REJECTED = 'rejected',
  FAILED = 'failed',
}

/** Why a buyer invoice was held, failed, or paid by an operator instead of auto-pay. */
export enum PeeringInvoiceReason {
  BUDGET_EXCEEDED = 'budget_exceeded',
  BUDGET_NOT_CONFIGURED = 'budget_not_configured',
  AUTO_PAY_DISABLED = 'auto_pay_disabled',
  AMOUNT_MISMATCH = 'amount_mismatch',
  UNKNOWN_PEER = 'unknown_peer',
  DUPLICATE = 'duplicate',
  UNSUPPORTED_PROCESSOR = 'unsupported_processor',
  PAYMENT_FAILED = 'payment_failed',
  EXPIRED = 'expired',
  INVALID_INVOICE = 'invalid_invoice',
}

export interface PeeringInvoice {
  /** BOLT11 payment hash; dedupe key across events and restarts. */
  paymentHash: string
  /** Kind 402 event that delivered this invoice. */
  eventId: string
  peerPubkey: Pubkey
  bolt11: string
  amountMsats: bigint
  status: PeeringInvoiceStatus
  reason?: PeeringInvoiceReason | null
  /** True only for an automatic payment; manual approvals are not auto-spend. */
  autoPaid: boolean
  budgetPeriodStart?: Date | null
  budgetPeriodEnd?: Date | null
  globalBudgetPeriodStart?: Date | null
  globalBudgetPeriodEnd?: Date | null
  /** Ownership token for the current wallet attempt. */
  paymentAttemptId?: string | null
  /** When the current attempt last started or submitted a payment. */
  paymentActivityAt?: Date | null
  /** Period this invoice buys from the peer, from the advertised term. */
  termPeriodSeconds?: number | null
  expiresAt?: Date | null
  seenCount: number
  paidAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface DBPeeringInvoice {
  payment_hash: string
  event_id: string
  peer_pubkey: Buffer
  bolt11: string
  amount_msats: string
  status: PeeringInvoiceStatus
  reason: PeeringInvoiceReason | null
  auto_paid: boolean
  budget_period_start: Date | null
  budget_period_end: Date | null
  global_budget_period_start: Date | null
  global_budget_period_end: Date | null
  payment_attempt_id: string | null
  payment_activity_at: Date | null
  term_period_seconds: number | null
  expires_at: Date | null
  seen_count: number
  paid_at: Date | null
  created_at: Date
  updated_at: Date
}

/** One budget counter, either `global` or `peer:<hex>`. */
export interface PeeringBudgetUsage {
  scope: string
  periodStart: Date
  periodEnd: Date
  spentMsats: bigint
}

/** Admin view of one budget window, with invoice counts for its peer. */
export interface PeeringBudgetSummary {
  scope: 'peer' | 'global'
  peerPubkey?: string
  periodStart: Date
  periodEnd: Date
  limitMsats: bigint
  spentMsats: bigint
  remainingMsats: bigint
  received: number
  paid: number
  held: number
}

export interface PeeringTermSnapshot {
  amountMsats: bigint
  periodSeconds: number
}

/**
 * Per-peer sync state. Written by the peering-sync worker and read by the admin
 * console; `lagSeconds` is how old the newest event we hold in a current scope
 * is, so a healthy live feed stays near zero.
 */
export interface PeeringPeerSyncState {
  pubkey: string
  relayUrl: string
  status: PeeringSyncStatus
  scopeCount: number
  updatedAt: string
  lastSyncStartedAt?: string
  lastSyncFinishedAt?: string
  lastReconciledAt?: string
  lastEventAt?: string
  /** Newest `created_at` held in a scope that is still current (no past `until`). */
  latestEventCreatedAt?: number
  lagSeconds?: number
  /** Events the last reconciliation found on the peer but not locally. */
  missingEvents?: number
  /** Events fetched from the peer during the last reconciliation. */
  receivedEvents?: number
  lastError?: string
}
