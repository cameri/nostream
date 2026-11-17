import { randomUUID } from 'crypto'

import { ICacheAdapter } from '../@types/adapters'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { RelayProbeRunSnapshot } from '../@types/relay-probe-snapshot'
import { createLogger } from '../factories/logger-factory'
import { enqueueOperatorNotification } from './operator-notification-enqueue'

const logger = createLogger('ops-trust-notifications')

const PROBE_STATUS_KEY = 'admin:trust:probe:last_status'
const PROBE_ALERT_CLAIM_KEY = 'admin:trust:probe:alert_claim'
const PROBE_PENDING_KEY = 'admin:trust:probe:pending'
const SSL_ALERT_PREFIX = 'admin:trust:ssl:alert:'

const SSL_EXPIRY_WARNING_DAYS = 14
const DEDUPE_TTL_SECONDS = 6 * 3600
const PROBE_STATUS_TTL_SECONDS = 86400 * 30
// Long enough for one enqueue, short enough that a crashed run does not block the next one for long.
const PROBE_ALERT_CLAIM_TTL_SECONDS = 60
// Results parked while a claim was held are handled after it; this bounds a chain of them.
const MAX_PROBE_TRANSITION_PASSES = 3

/**
 * Atomically compare the previous probe status with the new one and return the
 * alert to send, if any.
 *
 * - While another run holds the alert claim, this run's result is parked in a
 *   "pending" key (the latest one wins) and nothing is returned; the claim
 *   holder picks it up when it finishes, so a newer result is neither lost nor
 *   overwritten by the older alert.
 * - When there is nothing to alert, the new status is stored right away.
 * - When there is an alert, the stored status is left unchanged and the claim is
 *   taken with this run's token. The caller records the status only after the
 *   alert has been stored (see PROBE_FINISH_SCRIPT), so a failed save is retried
 *   by the next run instead of the transition being lost.
 */
const PROBE_TRANSITION_SCRIPT = `
local current = ARGV[1]
local ttl = tonumber(ARGV[2])
local claimTtl = tonumber(ARGV[3])
local token = ARGV[4]
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('SET', KEYS[3], ARGV[5], 'EX', claimTtl)
  return ''
end
redis.call('DEL', KEYS[3])
local prev = redis.call('GET', KEYS[1]) or ''
local action = ''
if prev ~= '' and (prev == 'failed' or prev == 'partial') and current == 'ok' then
  action = 'recovered'
elseif current ~= 'ok' and prev ~= current then
  action = 'failed'
end
if action == '' then
  redis.call('SET', KEYS[1], current, 'EX', ttl)
  return ''
end
redis.call('SET', KEYS[2], token, 'EX', claimTtl)
return action
`

/**
 * Record the status (when the alert was stored) and release the claim, but only
 * while the claim still holds this run's token: if it expired and another run
 * took it, this run must not delete that run's claim or overwrite its status.
 * Returns the result parked by a run that came in meanwhile, if any.
 */
const PROBE_FINISH_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return ''
end
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
end
redis.call('DEL', KEYS[2])
local pending = redis.call('GET', KEYS[3]) or ''
redis.call('DEL', KEYS[3])
return pending
`

const enqueueTrustNotification = async (
  eventType: OperatorNotificationEventType,
  payload: Record<string, unknown>,
): Promise<boolean> => {
  return enqueueOperatorNotification(eventType, payload)
}

const sendDedupedTrustNotification = async (
  cache: ICacheAdapter,
  dedupeKey: string,
  eventType: OperatorNotificationEventType,
  payload: Record<string, unknown>,
): Promise<void> => {
  let claimed = false
  try {
    claimed = await cache.setKeyIfNotExists(dedupeKey, 'pending', DEDUPE_TTL_SECONDS)
    if (!claimed) {
      return
    }

    const enqueued = await enqueueTrustNotification(eventType, payload)
    if (!enqueued) {
      await cache.deleteKey(dedupeKey)
      return
    }

    await cache.setKey(dedupeKey, '1', DEDUPE_TTL_SECONDS)
  } catch (error) {
    if (claimed) {
      try {
        await cache.deleteKey(dedupeKey)
      } catch {
        // best-effort release so a later attempt can retry
      }
    }
    throw error
  }
}

type ParkedProbeResult = Pick<RelayProbeRunSnapshot, 'status' | 'runAt' | 'targets'>

const parseParkedResult = (raw: unknown): ParkedProbeResult | undefined => {
  if (typeof raw !== 'string' || raw === '') {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ParkedProbeResult>
    if (typeof parsed.status === 'string' && typeof parsed.runAt === 'string' && Array.isArray(parsed.targets)) {
      return parsed as ParkedProbeResult
    }
  } catch {
    // an unreadable parked result is dropped; the next probe run decides again
  }

  return undefined
}

/** One pass of the probe transition. Returns a result that another run parked while this one held the claim. */
const processProbeTransition = async (
  cache: ICacheAdapter,
  snapshot: ParkedProbeResult,
): Promise<ParkedProbeResult | undefined> => {
  const token = randomUUID()
  let claimed = false
  let recorded = false

  try {
    const action = String(
      (await cache.eval(PROBE_TRANSITION_SCRIPT, [PROBE_STATUS_KEY, PROBE_ALERT_CLAIM_KEY, PROBE_PENDING_KEY], [
        snapshot.status,
        String(PROBE_STATUS_TTL_SECONDS),
        String(PROBE_ALERT_CLAIM_TTL_SECONDS),
        token,
        JSON.stringify({ status: snapshot.status, runAt: snapshot.runAt, targets: snapshot.targets }),
      ])) ?? '',
    )

    if (action !== 'recovered' && action !== 'failed') {
      return undefined
    }

    claimed = true
    const eventType =
      action === 'recovered' ? OperatorNotificationEventType.PROBE_RECOVERED : OperatorNotificationEventType.PROBE_FAILED
    const enqueued = await enqueueTrustNotification(eventType, {
      runAt: snapshot.runAt,
      status: snapshot.status,
      targets: snapshot.targets,
    })

    if (enqueued) {
      recorded = true
    } else {
      logger.error('probe %s notification was not enqueued; it will be retried on the next run', action)
    }
  } catch (error) {
    logger.error('probe transition notification failed: %o', error)
  }

  if (!claimed) {
    return undefined
  }

  try {
    // Only now is the transition recorded, so a failed enqueue is retried by the next run.
    const parked = await cache.eval(PROBE_FINISH_SCRIPT, [PROBE_STATUS_KEY, PROBE_ALERT_CLAIM_KEY, PROBE_PENDING_KEY], [
      token,
      recorded ? snapshot.status : '',
      String(PROBE_STATUS_TTL_SECONDS),
    ])

    return parseParkedResult(parked)
  } catch (error) {
    logger.error('probe alert claim could not be released: %o', error)
    return undefined
  }
}

export const notifyProbeRunTransition = async (
  cache: ICacheAdapter | undefined,
  snapshot: RelayProbeRunSnapshot,
): Promise<void> => {
  if (!cache) {
    return
  }

  let current: ParkedProbeResult | undefined = snapshot
  for (let pass = 0; current && pass < MAX_PROBE_TRANSITION_PASSES; pass++) {
    current = await processProbeTransition(cache, current)
  }

  try {
    await notifySslExpiringFromSnapshot(cache, snapshot)
  } catch (error) {
    logger.error('ssl expiring notifications failed: %o', error)
  }
}

const notifySslExpiringFromSnapshot = async (
  cache: ICacheAdapter,
  snapshot: RelayProbeRunSnapshot,
): Promise<void> => {
  const warningThresholdMs = SSL_EXPIRY_WARNING_DAYS * 86400 * 1000
  const now = Date.now()

  for (const result of snapshot.results) {
    const relayUrl = result.target.relayUrl
    const expiresAt = result.tls.data?.expiresAt
    if (!relayUrl || !expiresAt) {
      continue
    }

    const expiryMs = new Date(expiresAt).getTime()
    if (!Number.isFinite(expiryMs) || expiryMs <= now) {
      continue
    }

    const remainingMs = expiryMs - now
    if (remainingMs > warningThresholdMs) {
      continue
    }

    const dedupeKey = `${SSL_ALERT_PREFIX}${relayUrl}`
    try {
      await sendDedupedTrustNotification(cache, dedupeKey, OperatorNotificationEventType.SSL_EXPIRING, {
        relayUrl,
        expiresAt,
        daysRemaining: Math.ceil(remainingMs / 86400000),
      })
    } catch (error) {
      logger.error('ssl expiring notification failed for %s: %o', relayUrl, error)
    }
  }
}
