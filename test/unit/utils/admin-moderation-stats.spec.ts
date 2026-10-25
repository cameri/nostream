import { expect } from 'chai'
import Sinon from 'sinon'

import {
  parseModerationStatsLimit,
  parseModerationStatsWindowHours,
  queryTopClientIps,
  queryTopPublishingPubkeys,
} from '../../../src/utils/admin-moderation-stats'

describe('admin-moderation-stats parsing', () => {
  it('parses windowHours', () => {
    expect(parseModerationStatsWindowHours('24')).to.deep.equal({ hours: 24 })
    expect(parseModerationStatsWindowHours('720').hours).to.equal(720)
  })

  it('parses limit with bounds', () => {
    expect(parseModerationStatsLimit('15')).to.equal(15)
    expect(parseModerationStatsLimit('200')).to.equal(20)
    expect(parseModerationStatsLimit('0')).to.equal(20)
    expect(parseModerationStatsLimit(undefined)).to.equal(20)
  })
})

describe('admin-moderation-stats queries', () => {
  const buildQueryChain = (rows: unknown[]) => {
    const chain: Record<string, Sinon.SinonStub> = {}
    chain.select = Sinon.stub().returns(chain)
    chain.count = Sinon.stub().returns(chain)
    chain.whereNull = Sinon.stub().returns(chain)
    chain.where = Sinon.stub().returns(chain)
    chain.whereNotNull = Sinon.stub().returns(chain)
    chain.groupBy = Sinon.stub().returns(chain)
    chain.orderBy = Sinon.stub().returns(chain)
    chain.limit = Sinon.stub().returns(chain)
    chain.timeout = Sinon.stub().resolves(rows)
    return chain
  }

  it('maps top publishing pubkeys from the database', async () => {
    const chain = buildQueryChain([{ pubkey: 'e'.repeat(64), eventCount: '7' }])
    const db = Sinon.stub().returns(chain) as any
    db.raw = Sinon.stub().returns('raw')

    const rows = await queryTopPublishingPubkeys(db, 1_700_000_000, 5)

    expect(rows).to.deep.equal([{ pubkey: 'e'.repeat(64), eventCount: 7 }])
    expect(chain.limit.callCount).to.equal(1)
    expect(chain.where.calledWith('first_seen', '>=', new Date(1_700_000_000 * 1000))).to.equal(true)
  })

  it('maps top client IPs from the database', async () => {
    const chain = buildQueryChain([{ ip: '203.0.113.4', eventCount: 2 }])
    const db = Sinon.stub().returns(chain) as any
    db.raw = Sinon.stub().returns('raw')

    const rows = await queryTopClientIps(db, 1_700_000_000, 10)

    expect(rows).to.deep.equal([{ ip: '203.0.113.4', eventCount: 2 }])
    expect(chain.whereNotNull.callCount).to.equal(1)
    expect(chain.where.calledWith('first_seen', '>=', new Date(1_700_000_000 * 1000))).to.equal(true)
  })
})
