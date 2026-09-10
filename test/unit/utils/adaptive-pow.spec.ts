import { expect } from 'chai'

import { AdaptivePowSettings } from '../../../src/@types/settings'
import {
  getCurrentDifficulty,
  getCurrentEventsPerSecond,
  getCurrentRate,
  recordEvent,
  resetAdaptivePowState,
} from '../../../src/utils/adaptive-pow'

// Drives recordEvent() with events spaced 1000/eventsPerSecond ms apart for
// long enough (20 half-lives) to converge to the EWMA steady state for a
// real sustained rate -- same-instant bursts don't exercise the time
// normalization that getCurrentDifficulty applies to `rate`.
const simulateSustainedRate = (eventsPerSecond: number, periodMs: number, startAt = 1000): void => {
  const intervalMs = 1000 / eventsPerSecond
  const iterations = Math.ceil((periodMs * 20) / intervalMs)
  let now = startAt

  for (let i = 0; i < iterations; i++) {
    recordEvent(periodMs, now)
    now += intervalMs
  }
}

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

  describe('getCurrentEventsPerSecond', () => {
    it('is zero when no events have been recorded', () => {
      expect(getCurrentEventsPerSecond(60000)).to.equal(0)
    })

    it('converts the raw EWMA count back to a real events-per-second rate', () => {
      // A raw `rate` of 1 (single recorded event) is not "1 event/sec" -- it
      // must be divided by periodMs/1000/ln(2) (~86.56 at the 60s default)
      // to land in real events/sec units.
      recordEvent(60000, 1000)
      expect(getCurrentEventsPerSecond(60000)).to.be.closeTo(1 / (60000 / 1000 / Math.LN2), 1e-9)
    })

    it('reflects a real sustained rate after convergence', () => {
      simulateSustainedRate(5, 60000)
      expect(getCurrentEventsPerSecond(60000)).to.be.closeTo(5, 0.1)
    })
  })

  describe('getCurrentDifficulty', () => {
    it('returns floorBits when no events have been recorded', () => {
      expect(getCurrentDifficulty(config())).to.equal(8)
    })

    it('returns floorBits for a sustained rate safely under target', () => {
      simulateSustainedRate(5, 60000) // target is 10/s
      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10 }))).to.equal(8)
    })

    it('scales up linearly between floor and ceiling once the sustained rate exceeds target', () => {
      simulateSustainedRate(13, 60000) // 1.3x the 10/s target
      // Deliberately not 1.5x: that ratio lands the scaled value exactly on ceil()'s
      // integer boundary (0.5 * 16 = 8), where the EWMA's steady-state convergence
      // overshoots by a hair and flips the result to the next integer.

      // ratio=1.3 -> 8 + ceil(0.3 * (24-8)) = 8 + 5 = 13
      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10 }))).to.equal(13)
    })

    it('reaches ceilingBits at 2x the sustained target rate', () => {
      simulateSustainedRate(20, 60000) // exactly 2x the 10/s target

      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10, ceilingBits: 24 }))).to.equal(24)
    })

    it('clamps at ceilingBits no matter how far the sustained rate exceeds target', () => {
      simulateSustainedRate(200, 60000) // far beyond 2x target

      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10, ceilingBits: 24 }))).to.equal(24)
    })

    it('clamps at floorBits even if a misconfigured ceiling sits below the floor', () => {
      simulateSustainedRate(200, 60000)

      // ceilingBits < floorBits would otherwise scale to a value below floorBits;
      // validateSettings rejects this combination, but the pure function still
      // defends against it directly.
      expect(getCurrentDifficulty(config({ targetEventsPerSecond: 10, floorBits: 20, ceilingBits: 10 }))).to.equal(20)
    })

    it('returns floorBits when targetEventsPerSecond is non-positive', () => {
      simulateSustainedRate(50, 60000)

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
