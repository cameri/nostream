import { expect } from 'chai'

import { ICacheAdapter } from '../../../src/@types/adapters'
import { AdminOpsStore } from '../../../src/utils/admin-ops-store'

const createRecordingCache = (): { cache: ICacheAdapter; workerPayloads: string[] } => {
  const workerPayloads: string[] = []
  const cache: ICacheAdapter = {
    getKey: async () => '',
    hasKey: async () => false,
    setKey: async (key, value) => {
      if (key.startsWith('admin:ops:worker:')) {
        workerPayloads.push(value)
      }
      return true
    },
    setKeyIfNotExists: async () => true,
    addToSortedSet: async () => 0,
    removeRangeByScoreFromSortedSet: async () => 0,
    removeRangeByRankFromSortedSet: async () => 0,
    getRangeFromSortedSet: async () => [],
    setKeyExpiry: async () => {},
    deleteKey: async () => 0,
    getHKey: async () => '',
    setHKey: async () => true,
    addToSet: async () => 1,
    getSetMembers: async () => [],
    eval: async () => null,
  }

  return { cache, workerPayloads }
}

describe('AdminOpsStore', () => {
  it('overwrites worker heartbeats with the latest publish payload', async () => {
    const { cache, workerPayloads } = createRecordingCache()
    const store = new AdminOpsStore(cache)

    await store.publishWorker({
      type: 'relay-monitor',
      updatedAt: '2024-01-01T00:00:00.000Z',
      lastRunFinishedAt: '2024-01-01T00:00:00.000Z',
      lastError: 'probe failed',
    })

    await store.publishWorker({
      type: 'relay-monitor',
      updatedAt: '2024-01-01T00:00:45.000Z',
      lastRunFinishedAt: '2024-01-01T00:00:00.000Z',
      lastError: 'probe failed',
    })

    expect(workerPayloads).to.have.length(2)
    const latest = JSON.parse(workerPayloads[1]!)
    expect(latest.lastError).to.equal('probe failed')
    expect(latest.updatedAt).to.equal('2024-01-01T00:00:45.000Z')
  })
})
