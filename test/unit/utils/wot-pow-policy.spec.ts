import { expect } from 'chai'

import { applyWotPowPolicy } from '../../../src/utils/wot-pow-policy'
import { WotPowThreshold } from '../../../src/@types/settings'

describe('applyWotPowPolicy', () => {
  const thresholds: WotPowThreshold[] = [
    { maxDistance: 1, difficultyFactor: 0 },
    { maxDistance: 2, difficultyFactor: 0.5 },
  ]

  it('returns the computed difficulty unchanged when no thresholds are configured', () => {
    expect(applyWotPowPolicy(16, 1, undefined)).to.equal(16)
    expect(applyWotPowPolicy(16, 1, [])).to.equal(16)
  })

  it('returns the computed difficulty unchanged when distance is undefined (outside the trust graph)', () => {
    expect(applyWotPowPolicy(16, undefined, thresholds)).to.equal(16)
  })

  it('bypasses PoW entirely for a direct follow (distance 1, difficultyFactor 0)', () => {
    expect(applyWotPowPolicy(16, 1, thresholds)).to.equal(0)
  })

  it('applies a partial reduction at distance 2', () => {
    expect(applyWotPowPolicy(16, 2, thresholds)).to.equal(8)
  })

  it('rounds a partial reduction up (defender-favorable)', () => {
    expect(applyWotPowPolicy(15, 2, thresholds)).to.equal(8) // ceil(15 * 0.5) = 8
  })

  it('returns the full computed difficulty for a distance beyond every threshold', () => {
    expect(applyWotPowPolicy(16, 3, thresholds)).to.equal(16)
  })

  it('treats distance 0 (the seed pubkey itself) as eligible for the smallest threshold', () => {
    expect(applyWotPowPolicy(16, 0, thresholds)).to.equal(0)
  })

  it('picks the closest (smallest maxDistance) eligible threshold', () => {
    // distance 1 is eligible for both the maxDistance:1 and maxDistance:2 thresholds --
    // the tighter one (maxDistance:1, factor 0) should win, not the looser one.
    const reordered: WotPowThreshold[] = [
      { maxDistance: 2, difficultyFactor: 0.5 },
      { maxDistance: 1, difficultyFactor: 0 },
    ]
    expect(applyWotPowPolicy(16, 1, reordered)).to.equal(0)
  })

  it('supports a single bypass-everyone-in-the-graph threshold', () => {
    expect(applyWotPowPolicy(24, 10, [{ maxDistance: 10, difficultyFactor: 0 }])).to.equal(0)
  })
})
