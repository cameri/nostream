import { expect } from 'chai'

import { AdaptivePowSettings } from '../../../src/@types/settings'
import {
  getCurrentDifficulty,
  getCurrentRate,
  recordEvent,
  resetAdaptivePowState,
} from '../../../src/utils/adaptive-pow'

describe('adaptive-pow', () => {
  const config = (overrides: Partial<AdaptivePowSettings> = {}): AdaptivePowSettings => ({
    enabled: true,
    floorBits: 8,
    ceilingBits: 24,
    targetEventsPerSecond: 10,
    periodMs: 60000,
    ...overrides,
  })

  beforeEach(() => {
    resetAdaptivePowState()
  })

  describe('getCurrentRate', () => {
    it('starts at zero', () => {
      expect(getCurrentRate()).to.equal(0)
    })

    it('accumulates by step=1 per recorded event at the same instant', () => {
      recordEvent(60000, 1000)
      recordEvent(60000, 1000)
      recordEvent(60000, 1000)

      expect(getCurrentRate()).to.equal(3)
    })

    it('decays toward zero as time passes between events', () => {
      recordEvent(60000, 1000)
      const rateBeforeDecay = getCurrentRate()

      recordEvent(60000, 1000 + 60000) // one full half-life later
      const rateAfterDecay = getCurrentRate()

      expect(rateAfterDecay).to.be.lessThan(rateBeforeDecay + 1)
      expect(rateAfterDecay).to.be.greaterThan(1) // decayed contribution + the new hit
    })
  })

  describe('getCurrentDifficulty', () => {
    it('returns floorBits when no events have been recorded', () => {
      expect(getCurrentDifficulty(config())).to.equal(8)
    })

    it('returns floorBits while the observed rate is at or under target', () => {
      for (let i = 0; i < 10; i++) {
        recordEvent(60000, 1000)
      }

      expect(getCurrentRate()).to.equal(10)
      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10 }))).to.equal(8)
    })

    it('scales up linearly between floor and ceiling once the rate exceeds target', () => {
      for (let i = 0; i < 15; i++) {
        recordEvent(60000, 1000)
      }

      // rate=15, target=10 -> ratio=1.5 -> 8 + ceil(0.5 * (24-8)) = 8 + 8 = 16
      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10 }))).to.equal(16)
    })

    it('clamps at ceilingBits no matter how far the rate exceeds target', () => {
      for (let i = 0; i < 1000; i++) {
        recordEvent(60000, 1000)
      }

      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10, ceilingBits: 24 }))).to.equal(24)
    })

    it('returns floorBits when targetEventsPerSecond is non-positive', () => {
      for (let i = 0; i < 50; i++) {
        recordEvent(60000, 1000)
      }

      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 0 }))).to.equal(8)
    })
  })

  describe('resetAdaptivePowState', () => {
    it('clears the accumulated rate back to zero', () => {
      recordEvent(60000, 1000)
      recordEvent(60000, 1000)
      expect(getCurrentRate()).to.be.greaterThan(0)

      resetAdaptivePowState()

      expect(getCurrentRate()).to.equal(0)
    })
  })
})
