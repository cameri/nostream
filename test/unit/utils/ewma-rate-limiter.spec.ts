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
        it('reports no limit below the rate', async () => {
        evalStub.resolves('1')
        const result = await rateLimiter.hit('key', 1, { period: 120000, rate: 10 })
        expect(result.limited).to.be.false
        expect(result.retryAfterMs).to.be.undefined
        })

        it('reports a limit above the rate', async () => {
        evalStub.resolves('24')
        const result = await rateLimiter.hit('key', 1, { period: 60000, rate: 6 })
        expect(result.limited).to.be.true
        })

        // The script returns the score, not a verdict, so a truncated integer
        // would make the backoff wrong: 6.4 must not arrive as 6.
        it('reads a fractional score', async () => {
        evalStub.resolves('6.4')
        const result = await rateLimiter.hit('key', 1, { period: 60000, rate: 6 })
        expect(result.limited).to.be.true
        expect(result.retryAfterMs).to.equal(Math.ceil(60000 * Math.log2(6.4 / 5)))
        })

        // `period` is the half-life, and the next hit adds its step before the
        // comparison, so the score has to fall to `rate - step`: 24 down to 5 at
        // half-life 60 s is 2.26 periods, ~136 s, not the 60 s we used to send.
        it('sends the half-life backoff the next hit actually needs', async () => {
        evalStub.resolves('24')
        const result = await rateLimiter.hit('key', 1, { period: 60000, rate: 6 })
        expect(result.retryAfterMs).to.equal(135783)
        })

        // rate 1 with step 1 leaves no headroom: no decay admits another hit, so
        // the honest answer is one period, which is also the key's TTL.
        it('falls back to the period when no decay can admit a hit', async () => {
        evalStub.resolves('3')
        const result = await rateLimiter.hit('key', 1, { period: 60000, rate: 1 })
        expect(result.retryAfterMs).to.equal(60000)
        })

        it('never sends a zero or sub-millisecond backoff', async () => {
        evalStub.resolves('6.0000001')
        const result = await rateLimiter.hit('key', 1, { period: 60000, rate: 6 })
        expect(result.limited).to.be.true
        expect(result.retryAfterMs).to.be.at.least(1)
        })

        // A non-numeric answer means the script and the client disagree about
        // the protocol. Reading it as "allowed" would silently disable the
        // limiter; the caller fails closed on a throw.
        it('throws when the script returns something that is not a score', async () => {
        evalStub.resolves(null)
        let error: unknown
        try {
            await rateLimiter.hit('key', 1, { period: 120000, rate: 10 })
        } catch (caught) {
            error = caught
        }
        expect(error).to.be.instanceOf(Error)
        })

        // EWMA and sliding_window store different Redis types under the same
        // logical key name, so they must not share the physical key: a 2.x
        // volume, or an operator switching strategy, leaves a sorted set where
        // EWMA would then HSET and fail with WRONGTYPE on every request.
        it('namespaces the key it writes', async () => {
        evalStub.resolves('0')
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
