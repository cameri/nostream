import { EventId, Pubkey } from '../@types/base'
import { Event } from '../@types/event'
import { IReportRepository } from '../@types/repositories'
import { Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('hidden-content-cache')

const DEFAULT_REFRESH_INTERVAL_MS = 30000

/**
 * In-memory mirror of actionable-report targets, checked synchronously on the
 * live-broadcast path (WebSocketAdapter.onSendEvent), where events are
 * matched against open subscriptions in-process without a DB round trip.
 *
 * Every worker independently polls Postgres (the same `reports` table
 * EventRepository's REQ/COUNT exclusion already reads) on an interval and
 * *replaces* the mirror wholesale with that snapshot -- not an
 * accumulate-only cache. This is deliberately not Redis-backed: an earlier
 * version mirrored targets into Redis sets that only ever grew (SADD, never
 * removed), which meant a pruned/un-actionable report stayed hidden forever,
 * a failed initial seed never retried, and a refresh reading a stale Redis
 * snapshot could silently discard a target `markActionableTarget` had just
 * added locally. Polling Postgres directly removes all three failure modes
 * by construction: every tick is a full reconciliation against the actual
 * source of truth, not a diff against a second store that can itself drift.
 */
let hiddenPubkeys = new Set<string>()
let hiddenEventIds = new Set<string>()
let refreshTimer: ReturnType<typeof setInterval> | undefined

/**
 * Marks a target hidden in this worker's own mirror immediately, ahead of
 * the next scheduled poll -- so the worker that actually received the report
 * hides it for its own live subscribers right away instead of waiting up to
 * `intervalMs`. A refresh tick whose DB query snapshot was taken just before
 * this target's report committed can still overwrite this on one cycle; the
 * next poll always corrects it, since by then the report row is definitely
 * committed. This bounded, self-healing race is the same trade-off already
 * accepted elsewhere in this codebase (e.g. adaptive PoW's EWMA signal) for
 * a soft moderation gate, not a hard guarantee.
 */
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

const refreshFromDatabase = async (reportRepository: IReportRepository): Promise<void> => {
  const targets = await reportRepository.findActionableTargets()

  const nextPubkeys = new Set<string>()
  const nextEventIds = new Set<string>()
  for (const target of targets) {
    if (target.reportedPubkey) {
      nextPubkeys.add(target.reportedPubkey)
    }
    if (target.reportedEventId) {
      nextEventIds.add(target.reportedEventId)
    }
  }

  hiddenPubkeys = nextPubkeys
  hiddenEventIds = nextEventIds
}

/**
 * Starts the hidden-content cache: an initial full read from
 * `reportRepository.findActionableTargets()`, awaited at boot (unlike
 * WotGraphService's graph rebuild, this is a single indexed query -- cheap
 * enough that blocking briefly on it is worth live filtering being correct
 * from the first accepted connection), then a periodic re-read on
 * `intervalMs` timer that keeps running for as long as the worker is up, but
 * only actually queries the DB on a tick where `hideActionableReports` is
 * currently true. `reports` rows have no automatic retention (see
 * CONFIGURATION.md's nip56.enabled note), so continuously reading the full
 * actionable-target set while hiding is off would be an unbounded,
 * unused cost; checking the setting fresh on every tick instead of only at
 * start means a later hot-enable of hideActionableReports is still picked up
 * within one interval, without needing a separate start/stop call wired to
 * a settings-change event. A failed/partial read on any given tick
 * self-heals on the next one instead of needing a dedicated retry path.
 */
export const startHiddenContentCache = async (
  reportRepository: IReportRepository,
  settings: () => Pick<Settings, 'nip56'>,
  intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
): Promise<void> => {
  const pollIfEnabled = async (): Promise<void> => {
    if (!settings().nip56?.hideActionableReports) {
      return
    }
    await refreshFromDatabase(reportRepository)
  }

  try {
    await pollIfEnabled()
  } catch (error) {
    logger.error('failed to seed hidden content cache: %o', error)
  }

  stopHiddenContentCache()
  refreshTimer = setInterval(() => {
    pollIfEnabled().catch((error) => logger.error('failed to refresh hidden content cache: %o', error))
  }, intervalMs)
  refreshTimer.unref?.()
}

export const stopHiddenContentCache = (): void => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = undefined
  }
}

export const resetHiddenContentCache = (): void => {
  hiddenPubkeys.clear()
  hiddenEventIds.clear()
}
