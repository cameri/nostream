import { expect } from 'chai'
import Sinon from 'sinon'

import { ICacheAdapter } from '../../../src/@types/adapters'
import { IRateLimiter } from '../../../src/@types/utils'
import { SlidingWindowRateLimiter } from '../../../src/utils/sliding-window-rate-limiter'

describe('SlidingWindowRateLimiter', () => {
  let clock: Sinon.SinonFakeTimers
  let cache: ICacheAdapter
  let rateLimiter: IRateLimiter

  let removeRangeByScoreFromSortedSetStub: Sinon.SinonStub
  let addToSortedSetStub: Sinon.SinonStub
  let getRangeFromSortedSetStub: Sinon.SinonStub
  let setKeyExpiryStub: Sinon.SinonStub

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    clock = sandbox.useFakeTimers(1665546189000)
    removeRangeByScoreFromSortedSetStub = sandbox.stub()
    addToSortedSetStub = sandbox.stub()
    getRangeFromSortedSetStub = sandbox.stub()
    setKeyExpiryStub = sandbox.stub()
    cache = {
      removeRangeByScoreFromSortedSet: removeRangeByScoreFromSortedSetStub,
      addToSortedSet: addToSortedSetStub,
      getRangeFromSortedSet: getRangeFromSortedSetStub,
      setKeyExpiry: setKeyExpiryStub,
    }
    rateLimiter = new SlidingWindowRateLimiter(cache)
  })

  afterEach(() => {
    clock.restore()
    sandbox.restore()
  })

  it('returns true if rate limited', async () => {
    const now = Date.now()
    getRangeFromSortedSetStub.resolves([
      `${now}:6`,
      `${now}:4`,
      `${now}:1`,
    ])

    const actualResult = await rateLimiter.hit('key', 1, { period: 60000, rate: 10 })

    expect(actualResult).to.be.true
  })

  it('returns false if not rate limited',async () => {
    const now = Date.now()
    getRangeFromSortedSetStub.resolves([
      `${now}:10`,
    ])

    const actualResult = await rateLimiter.hit('key', 1, { period: 60000, rate: 10 })

    expect(actualResult).to.be.false
  })
})
