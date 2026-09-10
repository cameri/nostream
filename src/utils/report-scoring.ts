// A trusted moderator's report always carries maximum weight, independent of
// their WoT graph distance -- moderators are an explicit, separate trust
// source from the follow graph. Everyone else is scored purely by distance:
// a direct follow (distance 1) gets full weight, weight halves each
// additional hop, and a pubkey outside the trust graph entirely (distance
// undefined) gets zero -- stored, per NIP-56/§1a, but "doesn't trigger
// anything".
export const calculateReportWeight = (distance: number | undefined, isTrustedModerator: boolean): number => {
  if (isTrustedModerator) {
    return 1
  }
  if (distance === undefined) {
    return 0
  }
  return distance <= 0 ? 1 : 1 / distance
}
