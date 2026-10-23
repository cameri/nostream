import { AdaptivePowSettings } from '../@types/settings'
import { calculateEWMA } from './ewma-rate-limiter'

// Per-worker in-process state: adaptive PoW is a soft anti-spam gate, not a
// hard cross-worker limit, so there's no need to pay a Redis round-trip on
// every single event just to read a difficulty threshold.
let rate = 0
// 0, not Date.now(): the first recordEvent() call computes a huge deltaT
// against it, which decays rOld (0) to effectively nothing before adding
// the new hit -- exactly "never recorded before" without a special case.
let lastEventAt = 0

export const recordEvent = (periodMs: number, now: number = Date.now()): void => {
  rate = calculateEWMA(rate, Math.max(0, now - lastEventAt), periodMs, 1)
  lastEventAt = now
}

export const getCurrentRate = (): number => rate

// calculateEWMA's `rate` is a recency-weighted event count, not a per-second
// rate: at a steady R events/sec it converges to R * periodMs/1000/ln(2) --
// about 86.6x R at the default 60s half-life. Divide back out by that same
// factor before comparing against targetEventsPerSecond, which is per-second.
export const getCurrentEventsPerSecond = (periodMs: number): number => rate / (periodMs / 1000 / Math.LN2)

export const resetAdaptivePowState = (): void => {
  rate = 0
  lastEventAt = 0
}

export const getCurrentDifficulty = (config: AdaptivePowSettings): number => {
  const eventsPerSecond = getCurrentEventsPerSecond(config.periodMs)

  if (config.targetEventsPerSecond <= 0 || eventsPerSecond <= config.targetEventsPerSecond) {
    return config.floorBits
  }

  const ratio = eventsPerSecond / config.targetEventsPerSecond
  const scaled = config.floorBits + Math.ceil((ratio - 1) * (config.ceilingBits - config.floorBits))

  return Math.max(config.floorBits, Math.min(config.ceilingBits, scaled))
}
