// A trusted moderator's report always carries maximum weight, independent of
// their WoT graph distance -- moderators are an explicit, separate trust
// source from the follow graph. Everyone else is scored by exponential hop
// decay: a direct follow (distance 1) gets full weight, weight halves each
// additional hop (distance 2 -> 1/2, distance 3 -> 1/4, distance 4 -> 1/8,
// ...), and a pubkey outside the trust graph entirely (distance undefined)
// gets zero -- stored, per NIP-56/§1a, but "doesn't trigger anything".
export const calculateReportWeight = (distance: number | undefined, isTrustedModerator: boolean): number => {
  if (isTrustedModerator) {
    return 1
  }
  if (distance === undefined) {
    return 0
  }
  return distance <= 1 ? 1 : 1 / 2 ** (distance - 1)
}
