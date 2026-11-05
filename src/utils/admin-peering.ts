import { PeeringPeerSyncState } from '../@types/peering'
import { Settings } from '../@types/settings'
import { parsePeeringPeerPubkey } from './peering-auth'
import { PeeringRequestStats } from './peering-request-stats'
import { isPeeringSyncStateStale, PEERING_SYNC_STATE_STALE_AFTER_SECONDS } from './peering-sync-state'

export interface AdminPeeringRow {
  pubkey: string
  relayUrl: string
  configured: boolean
  enabled: boolean
  stale: boolean
  state?: PeeringPeerSyncState
  requests?: PeeringRequestStats
}

export const mergePeeringRows = (
  settings: Settings,
  states: PeeringPeerSyncState[],
  staleAfterSeconds = PEERING_SYNC_STATE_STALE_AFTER_SECONDS,
  requestStats: PeeringRequestStats[] = [],
): AdminPeeringRow[] => {
  const statesByPubkey = new Map(states.map((state) => [state.pubkey.toLowerCase(), state]))
  const requestsByPubkey = new Map(requestStats.map((stats) => [stats.pubkey.toLowerCase(), stats]))
  const rows: AdminPeeringRow[] = []
  const matched = new Set<string>()

  for (const peer of settings.peering?.peers ?? []) {
    const pubkey = parsePeeringPeerPubkey(peer.pubkey) ?? peer.pubkey
    const normalized = pubkey.toLowerCase()
    const stored = statesByPubkey.get(normalized)
    const state = stored?.relayUrl === peer.relayUrl ? stored : undefined
    const enabled = peer.enabled !== false

    matched.add(normalized)
    rows.push({
      pubkey,
      relayUrl: peer.relayUrl,
      configured: true,
      enabled,
      stale: enabled && (!state || isPeeringSyncStateStale(state.updatedAt, staleAfterSeconds)),
      state,
      requests: requestsByPubkey.get(normalized),
    })
  }

  // A peer removed from settings can still have a stored state row until its TTL
  // expires. Showing it makes a stale relationship obvious instead of hiding it.
  for (const state of states) {
    if (matched.has(state.pubkey.toLowerCase())) {
      continue
    }

    rows.push({
      pubkey: state.pubkey,
      relayUrl: state.relayUrl,
      configured: false,
      enabled: false,
      stale: isPeeringSyncStateStale(state.updatedAt, staleAfterSeconds),
      state,
      requests: requestsByPubkey.get(state.pubkey.toLowerCase()),
    })
  }

  return rows.sort((left, right) => {
    const relayCompare = left.relayUrl.localeCompare(right.relayUrl)
    return relayCompare !== 0 ? relayCompare : left.pubkey.localeCompare(right.pubkey)
  })
}
