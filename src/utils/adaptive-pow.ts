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

export const resetAdaptivePowState = (): void => {
  rate = 0
  lastEventAt = 0
}

export const getCurrentDifficulty = (config: AdaptivePowSettings): number => {
  if (config.targetEventsPerSecond <= 0 || rate <= config.targetEventsPerSecond) {
    return config.floorBits
  }

  const ratio = rate / config.targetEventsPerSecond
  const scaled = config.floorBits + Math.ceil((ratio - 1) * (config.ceilingBits - config.floorBits))

  return Math.min(config.ceilingBits, scaled)
}
