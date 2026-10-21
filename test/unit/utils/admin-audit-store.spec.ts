import { expect } from 'chai'
import sinon from 'sinon'

import { AdminAuditStore } from '../../../src/utils/admin-audit-store'
import { ICacheAdapter } from '../../../src/@types/adapters'

describe('AdminAuditStore', () => {
  let cache: sinon.SinonStubbedInstance<ICacheAdapter>

  beforeEach(() => {
    cache = {
      getKey: sinon.stub(),
      hasKey: sinon.stub(),
      setKey: sinon.stub(),
      setKeyIfNotExists: sinon.stub(),
      addToSortedSet: sinon.stub().resolves(1),
      removeRangeByScoreFromSortedSet: sinon.stub().resolves(0),
      removeRangeByRankFromSortedSet: sinon.stub().resolves(0),
      getRangeFromSortedSet: sinon.stub(),
      setKeyExpiry: sinon.stub(),
      deleteKey: sinon.stub(),
      getHKey: sinon.stub(),
      setHKey: sinon.stub(),
      addToSet: sinon.stub(),
      getSetMembers: sinon.stub(),
      eval: sinon.stub(),
    }
  })

  it('appends entries to the sorted set and trims', async () => {
    const store = new AdminAuditStore(cache)
    const entry = await store.append('admin.login', { remoteAddress: '127.0.0.1' })

    expect(entry.action).to.equal('admin.login')
    expect(entry.remoteAddress).to.equal('127.0.0.1')
    expect(cache.addToSortedSet.calledOnce).to.equal(true)
    expect(cache.removeRangeByRankFromSortedSet.called).to.equal(true)
  })

  it('lists entries newest-first', async () => {
    const older = JSON.stringify({ id: '1', at: '2020-01-01T00:00:00.000Z', action: 'admin.logout' })
    const newer = JSON.stringify({ id: '2', at: '2020-01-02T00:00:00.000Z', action: 'admin.login' })
    cache.getRangeFromSortedSet.resolves([older, newer])

    const store = new AdminAuditStore(cache)
    const entries = await store.list(10)

    expect(entries.map((entry) => entry.id)).to.deep.equal(['2', '1'])
  })
})
