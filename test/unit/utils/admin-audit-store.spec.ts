import chai from 'chai'

import { ICacheAdapter } from '../../../src/@types/adapters'
import { AdminAuditStore } from '../../../src/utils/admin-audit-store'

const { expect } = chai

const createCacheStub = (): ICacheAdapter => ({
  getKey: async () => '',
  hasKey: async () => false,
  setKey: async () => true,
  setKeyIfNotExists: async () => true,
  addToSortedSet: async () => 1,
  removeRangeByScoreFromSortedSet: async () => 0,
  removeRangeByRankFromSortedSet: async () => 0,
  getRangeFromSortedSet: async () => [],
  setKeyExpiry: async () => {},
  deleteKey: async () => 1,
  getHKey: async () => '',
  setHKey: async () => true,
  addToSet: async () => 1,
  getSetMembers: async () => [],
  eval: async () => '',
})

describe('AdminAuditStore', () => {
  it('appends entries to the sorted set and trims', async () => {
    const cache = createCacheStub()
    let addCalls = 0
    cache.addToSortedSet = async () => {
      addCalls += 1
      return 1
    }

    const store = new AdminAuditStore(cache)
    const entry = await store.append('admin.login', { remoteAddress: '127.0.0.1' })

    expect(entry.action).to.equal('admin.login')
    expect(entry.remoteAddress).to.equal('127.0.0.1')
    expect(addCalls).to.equal(1)
  })

  it('lists entries newest-first', async () => {
    const older = JSON.stringify({ id: '1', at: '2020-01-01T00:00:00.000Z', action: 'admin.logout' })
    const newer = JSON.stringify({ id: '2', at: '2020-01-02T00:00:00.000Z', action: 'admin.login' })
    const cache = createCacheStub()
    cache.getRangeFromSortedSet = async () => [older, newer]

    const store = new AdminAuditStore(cache)
    const entries = await store.list(10)

    expect(entries.map((entry) => entry.id)).to.deep.equal(['2', '1'])
  })
})
