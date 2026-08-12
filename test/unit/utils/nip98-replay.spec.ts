import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

import {
  claimNip98AuthEventId,
  nip98AuthReplayCacheKey,
  resetNip98ReplayCacheAdapterForTests,
  resolveNip98ReplayTtlSeconds,
} from '../../../src/utils/nip98-replay'

chai.use(chaiAsPromised)

const { expect } = chai

describe('nip98-replay', () => {
  afterEach(() => {
    resetNip98ReplayCacheAdapterForTests()
    Sinon.restore()
  })

  it('builds a stable cache key', () => {
    expect(nip98AuthReplayCacheKey('abc')).to.equal('nip98:auth:abc')
  })

  it('claims a fresh event id', async () => {
    const cache = {
      setKeyIfNotExists: Sinon.stub().resolves(true),
    }

    await expect(claimNip98AuthEventId('event-id', 60, cache as any)).to.eventually.equal('claimed')
    expect(cache.setKeyIfNotExists).to.have.been.calledOnceWithExactly('nip98:auth:event-id', '1', 60)
  })

  it('detects replays when NX set fails', async () => {
    const cache = {
      setKeyIfNotExists: Sinon.stub().resolves(false),
    }

    await expect(claimNip98AuthEventId('event-id', 60, cache as any)).to.eventually.equal('replay')
  })

  it('fails closed when redis throws', async () => {
    const cache = {
      setKeyIfNotExists: Sinon.stub().rejects(new Error('redis down')),
    }

    await expect(claimNip98AuthEventId('event-id', 60, cache as any)).to.eventually.equal('unavailable')
  })

  describe('resolveNip98ReplayTtlSeconds', () => {
    const now = 1_700_000_000
    const skew = 60

    it('keeps the claim through created_at + maxSkew inclusive', () => {
      expect(resolveNip98ReplayTtlSeconds(now, skew, now)).to.equal(skew + 1)
    })

    it('covers a future-dated event until it leaves the skew window', () => {
      expect(resolveNip98ReplayTtlSeconds(now + skew, skew, now)).to.equal(2 * skew + 1)
    })

    it('uses a 1s ttl at the last valid second', () => {
      expect(resolveNip98ReplayTtlSeconds(now - skew, skew, now)).to.equal(1)
    })

    it('clamps expired or invalid remaining windows to 1s', () => {
      expect(resolveNip98ReplayTtlSeconds(now - skew - 1, skew, now)).to.equal(1)
      expect(resolveNip98ReplayTtlSeconds(Number.NaN, skew, now)).to.equal(1)
    })

    it('falls back to the default skew when maxSkewSeconds is missing', () => {
      expect(resolveNip98ReplayTtlSeconds(now, undefined, now)).to.equal(61)
    })
  })
})
