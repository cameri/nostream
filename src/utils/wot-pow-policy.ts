import { WotPowThreshold } from '../@types/settings'

// A pubkey outside the trust graph (distance undefined) or with no eligible
// threshold gets the full computed difficulty unchanged -- reductions are an
// earned benefit of being inside the operator's trust circle, never a default.
export const applyWotPowPolicy = (
  computedDifficulty: number,
  distance: number | undefined,
  thresholds: WotPowThreshold[] | undefined,
): number => {
  if (!thresholds?.length || distance === undefined) {
    return computedDifficulty
  }

  const eligible = thresholds.filter((threshold) => distance <= threshold.maxDistance)
  if (!eligible.length) {
    return computedDifficulty
  }

  // The closest (smallest maxDistance) eligible threshold wins -- e.g. with
  // thresholds at maxDistance 1 and 2, a distance-1 pubkey gets the tighter
  // (usually more generous) distance-1 reduction, not the distance-2 one.
  const closest = eligible.reduce((best, threshold) => (threshold.maxDistance < best.maxDistance ? threshold : best))

  return Math.ceil(computedDifficulty * closest.difficultyFactor)
}
