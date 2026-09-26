import { EventId, Pubkey } from '../@types/base'
import { Event } from '../@types/event'
import { IReportRepository } from '../@types/repositories'

/**
 * In-memory mirror of actionable-report targets, so EventRepository's
 * NOT-EXISTS-based hiding (which only applies to fresh REQ/COUNT queries) can
 * also be checked synchronously on the live-broadcast path, where events are
 * matched against open subscriptions in-process without a DB round trip.
 */
const hiddenPubkeys = new Set<string>()
const hiddenEventIds = new Set<string>()

export const markActionableTarget = (target: { reportedPubkey: Pubkey | null; reportedEventId: EventId | null }): void => {
  if (target.reportedPubkey) {
    hiddenPubkeys.add(target.reportedPubkey)
  }
  if (target.reportedEventId) {
    hiddenEventIds.add(target.reportedEventId)
  }
}

export const isHidden = (event: Pick<Event, 'id' | 'pubkey'>): boolean =>
  hiddenPubkeys.has(event.pubkey) || hiddenEventIds.has(event.id)

/** Populates the cache from every actionable report already in the DB, at worker boot. */
export const warmHiddenContentCache = async (reportRepository: IReportRepository): Promise<void> => {
  const targets = await reportRepository.findActionableTargets()
  targets.forEach(markActionableTarget)
}

export const resetHiddenContentCache = (): void => {
  hiddenPubkeys.clear()
  hiddenEventIds.clear()
}
