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
  let getKeyStub: Sinon.SinonStub
  let hasKeyStub: Sinon.SinonStub
  let setKeyStub: Sinon.SinonStub
  let evalStub: Sinon.SinonStub

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    clock = sandbox.useFakeTimers(1665546189000)
    removeRangeByScoreFromSortedSetStub = sandbox.stub()
    addToSortedSetStub = sandbox.stub()
    getRangeFromSortedSetStub = sandbox.stub()
    setKeyExpiryStub = sandbox.stub()
    getKeyStub = sandbox.stub()
    hasKeyStub = sandbox.stub()
    setKeyStub = sandbox.stub()
    evalStub = sandbox.stub()
    cache = {
      removeRangeByScoreFromSortedSet: removeRangeByScoreFromSortedSetStub,
      addToSortedSet: addToSortedSetStub,
      getRangeFromSortedSet: getRangeFromSortedSetStub,
      setKeyExpiry: setKeyExpiryStub,
      getKey: getKeyStub,
      hasKey: hasKeyStub,
      setKey: setKeyStub,
      eval: evalStub,
    } as unknown as ICacheAdapter


    rateLimiter = new SlidingWindowRateLimiter(cache)
  })

  afterEach(() => {
    clock.restore()
    sandbox.restore()
  })

  it('returns true if rate limited', async () => {
    evalStub.resolves(1)

    const actualResult = await rateLimiter.hit('key', 1, { period: 60000, rate: 10 })

    expect(actualResult).to.be.true
    expect(evalStub).to.have.been.calledOnce
    const args = evalStub.firstCall.args
    expect(args[1]).to.deep.equal(['key'])
    expect(args[2][1]).to.equal('60000') // period
    expect(args[2][2]).to.equal('1') // step
    expect(args[2][3]).to.equal('10') // max_rate
  })

  it('returns false if not rate limited', async () => {
    evalStub.resolves(0)

    const actualResult = await rateLimiter.hit('key', 1, { period: 60000, rate: 10 })

    expect(actualResult).to.be.false
  })

  it('robustly handles string return types from Redis', async () => {
    evalStub.resolves('1')

    const actualResult = await rateLimiter.hit('key', 1, { period: 60000, rate: 10 })

    expect(actualResult).to.be.true
  })
})
