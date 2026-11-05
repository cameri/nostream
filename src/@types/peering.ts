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
