import { expect } from 'chai'
import { calculateReportWeight } from '../../../src/utils/report-scoring'

describe('calculateReportWeight', () => {
  it('returns maximum weight for a trusted moderator regardless of distance', () => {
    expect(calculateReportWeight(undefined, true)).to.equal(1)
    expect(calculateReportWeight(5, true)).to.equal(1)
  })

  it('returns 0 for a non-moderator with no WoT distance (outside the trust graph)', () => {
    expect(calculateReportWeight(undefined, false)).to.equal(0)
  })

  it('returns full weight for a non-moderator direct follow (distance 1)', () => {
    expect(calculateReportWeight(1, false)).to.equal(1)
  })

  it('returns half weight for a non-moderator at distance 2', () => {
    expect(calculateReportWeight(2, false)).to.equal(0.5)
  })

  it('halves again for each additional hop', () => {
    expect(calculateReportWeight(4, false)).to.equal(0.25)
  })

  it('treats distance 0 (the seed pubkey itself) as full weight', () => {
    expect(calculateReportWeight(0, false)).to.equal(1)
  })
})
