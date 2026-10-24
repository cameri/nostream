import { expect } from 'chai'
import Sinon from 'sinon'

import { calculateEWMA, EWMA_KEY_PREFIX, EWMARateLimiter, ewmaKey } from '../../../src/utils/ewma-rate-limiter'
import { ICacheAdapter } from '../../../src/@types/adapters'
import { IRateLimiter } from '../../../src/@types/utils'

describe('EWMARateLimiter', () => {
  let clock: Sinon.SinonFakeTimers
  let cache: ICacheAdapter
  let rateLimiter: IRateLimiter

  let evalStub: Sinon.SinonStub
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    clock = sandbox.useFakeTimers(1665546189000)
    evalStub = sandbox.stub()
    cache = {
        eval: evalStub,
    } as unknown as ICacheAdapter
    rateLimiter = new EWMARateLimiter(cache)
  })

  afterEach(() => {
    clock.restore()
    sandbox.restore()
  })
    describe('calculateEWMA', () => {
        it('returns 1 on first request with no history', () => {
        const result = calculateEWMA(0, 0, 120000, 1)
        expect(result).to.equal(1)
        })

        it('increases rate on burst requests with no time gap', () => {
        const first = calculateEWMA(0, 0, 120000, 1)
        const second = calculateEWMA(first, 0, 120000, 1)
        const third = calculateEWMA(second, 0, 120000, 1)

        expect(third).to.be.greaterThan(first)
        })

        it('decays rate after time gap', () => {
        const rateAfterBurst = calculateEWMA(10, 0, 120000, 1)
        const rateAfterGap = calculateEWMA(rateAfterBurst, 120000, 120000, 1)

        expect(rateAfterGap).to.be.lessThan(rateAfterBurst)
        })

        it('rate approaches 1 after very long inactivity', () => {
        const rateAfterBurst = calculateEWMA(10, 0, 120000, 1)
        const rateAfterLongGap = calculateEWMA(rateAfterBurst, 9999999, 120000, 1)

        expect(rateAfterLongGap).to.be.closeTo(1, 0.001)
        })
    })

    describe('hit', () => {
        it('returns false on first request', async () => {
        evalStub.resolves(0)
        const result = await rateLimiter.hit('key', 1, { period: 120000, rate: 10 })
        expect(result).to.be.false
        })

        it('returns true when rate limit exceeded', async () => {
        evalStub.resolves(1)
        const result = await rateLimiter.hit('key', 1, { period: 120000, rate: 10 })
        expect(result).to.be.true
        })

        // EWMA and sliding_window store different Redis types under the same
        // logical key name, so they must not share the physical key: a 2.x
        // volume, or an operator switching strategy, leaves a sorted set where
        // EWMA would then HSET and fail with WRONGTYPE on every request.
        it('namespaces the key it writes', async () => {
        evalStub.resolves(0)
        await rateLimiter.hit('1.2.3.4:connection:120000', 1, { period: 120000, rate: 10 })

        expect(evalStub.calledOnce).to.be.true
        expect(evalStub.firstCall.args[1]).to.deep.equal(['ewma:1.2.3.4:connection:120000'])
        })

        it('builds the namespaced key from any caller key', () => {
        expect(ewmaKey('abc:message:60000')).to.equal('ewma:abc:message:60000')
        expect(EWMA_KEY_PREFIX).to.equal('ewma:')
        })
    })
})
