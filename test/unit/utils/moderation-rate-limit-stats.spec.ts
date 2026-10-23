import { expect } from 'chai'
import Sinon from 'sinon'

import { ICacheAdapter } from '../../../src/@types/adapters'
import {
  listModerationRateLimitHits,
  recordModerationRateLimitHitSafely,
  utcDayBucketSuffix,
} from '../../../src/utils/moderation-rate-limit-stats'

describe('moderation-rate-limit-stats', () => {
  it('formats UTC day bucket suffixes', () => {
    const suffix = utcDayBucketSuffix(Date.UTC(2026, 9, 23, 15, 30, 0))
    expect(suffix).to.equal('20261023')
  })

  it('skips recording when cache has no eval', async () => {
    const cache = {} as ICacheAdapter
    await recordModerationRateLimitHitSafely(cache, { pubkey: 'a'.repeat(64), ip: '127.0.0.1' })
  })

  it('records pubkey and ip hits via eval', async () => {
    const evalStub = Sinon.stub().resolves(1)
    const cache = { eval: evalStub } as unknown as ICacheAdapter

    await recordModerationRateLimitHitSafely(cache, { pubkey: 'A'.repeat(64), ip: '127.0.0.1' })

    expect(evalStub).to.have.been.calledTwice
    expect(evalStub.firstCall.args[1][0]).to.match(/^admin:moderation:rate-limit:pubkeys:\d{8}$/)
    expect(evalStub.firstCall.args[2][0]).to.equal('a'.repeat(64))
  })

  it('lists aggregated top hits from redis eval', async () => {
    const evalStub = Sinon.stub()
    evalStub.onFirstCall().resolves(['pubkey-a', '3'])
    evalStub.onSecondCall().resolves(['127.0.0.1', '2'])
    const cache = { eval: evalStub } as unknown as ICacheAdapter

    const result = await listModerationRateLimitHits(cache, 5, 24)

    expect(result.pubkeys).to.deep.equal([{ key: 'pubkey-a', hits: 3 }])
    expect(result.ips).to.deep.equal([{ key: '127.0.0.1', hits: 2 }])
    expect(evalStub.callCount).to.equal(2)
  })
})
