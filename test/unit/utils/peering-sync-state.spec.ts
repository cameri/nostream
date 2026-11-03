import { expect } from 'chai'

import { ICacheAdapter } from '../../../src/@types/adapters'
import { PEERING_SYNC_STATE_INDEX_KEY, PeeringSyncStateStore } from '../../../src/utils/peering-sync-state'

const createCache = (): ICacheAdapter & { values: Map<string, string>; sets: Map<string, string[]> } => {
  const values = new Map<string, string>()
  const sets = new Map<string, string[]>()

  return {
    values,
    sets,
    getKey: async (key) => values.get(key) ?? '',
    hasKey: async (key) => values.has(key),
    setKey: async (key, value) => {
      values.set(key, value)
      return true
    },
    setKeyIfNotExists: async (key, value) => {
      if (values.has(key)) {
        return false
      }
      values.set(key, value)
      return true
    },
    addToSortedSet: async () => 0,
    removeRangeByScoreFromSortedSet: async () => 0,
    removeRangeByRankFromSortedSet: async () => 0,
    getRangeFromSortedSet: async () => [],
    setKeyExpiry: async () => {},
    deleteKey: async () => 0,
    getHKey: async () => '',
    setHKey: async () => true,
    addToSet: async (key, members) => {
      const current = sets.get(key) ?? []
      sets.set(key, [...new Set([...current, ...members])])
      return members.length
    },
    getSetMembers: async (key) => sets.get(key) ?? [],
    eval: async () => null,
  }
}

describe('PeeringSyncStateStore', () => {
  it('publishes and lists per-peer state', async () => {
    const cache = createCache()
    const store = new PeeringSyncStateStore(cache)

    await store.publish({
      pubkey: 'A'.repeat(64),
      relayUrl: 'wss://peer.example.com',
      status: 'live',
      scopeCount: 1,
      updatedAt: '2024-01-01T00:00:00.000Z',
      lastReconciledAt: '2024-01-01T00:00:00.000Z',
      lastError: 'failed to connect to wss://peer.example.com',
    })

    expect(cache.sets.get(PEERING_SYNC_STATE_INDEX_KEY)).to.deep.equal(['a'.repeat(64)])
    const states = await store.list()

    expect(states).to.have.length(1)
    expect(states[0].pubkey).to.equal('a'.repeat(64))
    expect(states[0].lastError).to.equal('failed to connect to [url]')
  })
})
