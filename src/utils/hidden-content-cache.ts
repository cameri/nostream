import { ICacheAdapter } from '../@types/adapters'
import { EventId, Pubkey } from '../@types/base'
import { Event } from '../@types/event'
import { IReportRepository } from '../@types/repositories'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('hidden-content-cache')

const HIDDEN_PUBKEYS_KEY = 'nip56:hidden:pubkeys'
const HIDDEN_EVENT_IDS_KEY = 'nip56:hidden:event_ids'
const DEFAULT_REFRESH_INTERVAL_MS = 30000

/**
 * In-memory mirror of actionable-report targets, checked synchronously on the
 * live-broadcast path (WebSocketAdapter.onSendEvent), where events are
 * matched against open subscriptions in-process without a DB round trip.
 * Redis (via ICacheAdapter.addToSet/getSetMembers, the same primitives
 * WotGraphService's follow-set persistence already uses) is the
 * cross-worker source of truth this mirror is kept in sync with -- a bare
 * per-process Set would only ever reflect reports the worker that received
 * them happened to process itself.
 */
let hiddenPubkeys = new Set<string>()
let hiddenEventIds = new Set<string>()
let refreshTimer: ReturnType<typeof setInterval> | undefined

export const markActionableTarget = async (
  cache: ICacheAdapter,
  target: { reportedPubkey: Pubkey | null; reportedEventId: EventId | null },
): Promise<void> => {
  if (target.reportedPubkey) {
    hiddenPubkeys.add(target.reportedPubkey)
    await cache.addToSet(HIDDEN_PUBKEYS_KEY, [target.reportedPubkey])
  }
  if (target.reportedEventId) {
    hiddenEventIds.add(target.reportedEventId)
    await cache.addToSet(HIDDEN_EVENT_IDS_KEY, [target.reportedEventId])
  }
}

export const isHidden = (event: Pick<Event, 'id' | 'pubkey'>): boolean =>
  hiddenPubkeys.has(event.pubkey) || hiddenEventIds.has(event.id)

const refreshFromCache = async (cache: ICacheAdapter): Promise<void> => {
  const [pubkeys, eventIds] = await Promise.all([cache.getSetMembers(HIDDEN_PUBKEYS_KEY), cache.getSetMembers(HIDDEN_EVENT_IDS_KEY)])
  hiddenPubkeys = new Set(pubkeys)
  hiddenEventIds = new Set(eventIds)
}

/**
 * Starts the hidden-content cache: seeds Redis from every actionable report
 * already in the DB (idempotent -- SADD is a no-op for members already
 * present, so this is safe to run on every worker's boot regardless of
 * whether Redis already has the data from a prior boot or a sibling
 * worker), loads the merged Redis state into the in-memory mirror, and
 * keeps refreshing that mirror from Redis on an interval.
 *
 * Awaited at boot (unlike WotGraphService's graph rebuild, this is a single
 * indexed DB query plus a couple of Redis reads -- cheap enough that
 * blocking briefly on it is worth live filtering being correct from the
 * first accepted connection, rather than reproducing the "first caller pays
 * for a cold cache" gap already fixed once for WotGraphService).
 *
 * The refresh interval runs for as long as nip56 is enabled at all, not
 * only while hideActionableReports is -- so hot-enabling
 * hideActionableReports later finds an already-current cache instead of one
 * that was never warmed, and a transient DB/Redis failure at boot
 * self-heals on the next tick instead of needing a dedicated retry path.
 */
export const startHiddenContentCache = async (
  cache: ICacheAdapter,
  reportRepository: IReportRepository,
  intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
): Promise<void> => {
  try {
    const targets = await reportRepository.findActionableTargets()
    await Promise.all(targets.map((target) => markActionableTarget(cache, target)))
    await refreshFromCache(cache)
  } catch (error) {
    logger.error('failed to seed hidden content cache: %o', error)
  }

  stopHiddenContentCache()
  refreshTimer = setInterval(() => {
    refreshFromCache(cache).catch((error) => logger.error('failed to refresh hidden content cache: %o', error))
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
