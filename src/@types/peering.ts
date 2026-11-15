import { Pubkey } from './base'
import { PeeringScope, PeeringTerm } from './settings'

/** One scope advertised by a peer in its NIP-11 `peering` section. */
export type AdvertisedPeeringScope = PeeringScope

export interface PeeringAdvertisement {
  enabled: boolean
  scopes: AdvertisedPeeringScope[]
  terms: PeeringTerm[]
  /** The relay key the peer advertises as `self`, when it publishes one. */
  self?: string
  supportedNips: number[]
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
