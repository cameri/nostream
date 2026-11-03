import { ICacheAdapter } from '../@types/adapters'
import { PeeringPeerSyncState } from '../@types/peering'
import { createLogger } from '../factories/logger-factory'
import { sanitizeAdminOpsError } from './admin-ops-sanitize'

const logger = createLogger('peering-sync-state')

export const PEERING_SYNC_STATE_INDEX_KEY = 'admin:peering:sync:index'
export const PEERING_SYNC_STATE_TTL_SECONDS = 7 * 24 * 60 * 60
/** A peer whose state has not moved for two reconciliation intervals is stale. */
export const PEERING_SYNC_STATE_STALE_AFTER_SECONDS = 30 * 60

const stateKey = (pubkey: string): string => `admin:peering:sync:${pubkey.toLowerCase()}`

export class PeeringSyncStateStore {
  public constructor(private readonly cache: ICacheAdapter) {}

  public async publish(state: PeeringPeerSyncState): Promise<void> {
    const sanitized: PeeringPeerSyncState = {
      ...state,
      pubkey: state.pubkey.toLowerCase(),
      lastError: state.lastError !== undefined ? sanitizeAdminOpsError(state.lastError) : undefined,
    }

    await this.cache.setKey(stateKey(sanitized.pubkey), JSON.stringify(sanitized), PEERING_SYNC_STATE_TTL_SECONDS)
    await this.cache.addToSet(PEERING_SYNC_STATE_INDEX_KEY, [sanitized.pubkey])
    await this.cache.setKeyExpiry(PEERING_SYNC_STATE_INDEX_KEY, PEERING_SYNC_STATE_TTL_SECONDS)
  }

  public async list(): Promise<PeeringPeerSyncState[]> {
    const pubkeys = await this.cache.getSetMembers(PEERING_SYNC_STATE_INDEX_KEY)
    const states: PeeringPeerSyncState[] = []

    for (const pubkey of pubkeys) {
      const raw = await this.cache.getKey(stateKey(pubkey))
      if (!raw) {
        continue
      }

      try {
        states.push(JSON.parse(raw) as PeeringPeerSyncState)
      } catch {
        logger.warn('ignoring corrupt peering sync state for %s', pubkey)
      }
    }

    return states.sort((left, right) => left.pubkey.localeCompare(right.pubkey))
  }
}

export const isPeeringSyncStateStale = (updatedAtIso: string | undefined, staleAfterSeconds: number): boolean => {
  if (!updatedAtIso) {
    return true
  }

  const updatedAt = Date.parse(updatedAtIso)
  if (!Number.isFinite(updatedAt)) {
    return true
  }

  return Date.now() - updatedAt > staleAfterSeconds * 1000
}
