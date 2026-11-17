import { ICacheAdapter } from '../@types/adapters'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { RelayProbeRunSnapshot } from '../@types/relay-probe-snapshot'
import { createLogger } from '../factories/logger-factory'
import { enqueueOperatorNotification } from './operator-notification-enqueue'

const logger = createLogger('ops-trust-notifications')

const PROBE_STATUS_KEY = 'admin:trust:probe:last_status'
const PROBE_ALERT_CLAIM_KEY = 'admin:trust:probe:alert_claim'
const SSL_ALERT_PREFIX = 'admin:trust:ssl:alert:'

const SSL_EXPIRY_WARNING_DAYS = 14
const DEDUPE_TTL_SECONDS = 6 * 3600
const PROBE_STATUS_TTL_SECONDS = 86400 * 30
// Long enough for one enqueue, short enough that a crashed run does not block the next one for long.
const PROBE_ALERT_CLAIM_TTL_SECONDS = 60

/**
 * Atomically compare the previous probe status with the new one and return the
 * alert to send, if any.
 *
 * When there is nothing to alert the new status is stored right away. When there
 * is an alert, the stored status is left unchanged and a short claim is taken so
 * that only one run enqueues it; the caller advances the status after the alert
 * has been stored. If storing it fails, the next run still sees the old status
 * and tries the same alert again, instead of the transition being lost.
 */
const PROBE_TRANSITION_SCRIPT = `
local prev = redis.call('GET', KEYS[1]) or ''
local current = ARGV[1]
local ttl = tonumber(ARGV[2])
local claimTtl = tonumber(ARGV[3])
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
if not redis.call('SET', KEYS[2], '1', 'NX', 'EX', claimTtl) then
  return ''
end
return action
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

export const notifyProbeRunTransition = async (
  cache: ICacheAdapter | undefined,
  snapshot: RelayProbeRunSnapshot,
): Promise<void> => {
  if (!cache) {
    return
  }

  let claimed = false
  try {
    const action = String(
      (await cache.eval(PROBE_TRANSITION_SCRIPT, [PROBE_STATUS_KEY, PROBE_ALERT_CLAIM_KEY], [
        snapshot.status,
        String(PROBE_STATUS_TTL_SECONDS),
        String(PROBE_ALERT_CLAIM_TTL_SECONDS),
      ])) ?? '',
    )

    if (action === 'recovered' || action === 'failed') {
      claimed = true
      const eventType =
        action === 'recovered' ? OperatorNotificationEventType.PROBE_RECOVERED : OperatorNotificationEventType.PROBE_FAILED
      const enqueued = await enqueueTrustNotification(eventType, {
        runAt: snapshot.runAt,
        status: snapshot.status,
        targets: snapshot.targets,
      })

      if (enqueued) {
        // Only now is the transition recorded, so a failed enqueue is retried by the next run.
        await cache.setKey(PROBE_STATUS_KEY, snapshot.status, PROBE_STATUS_TTL_SECONDS)
      } else {
        logger.error('probe %s notification was not enqueued; it will be retried on the next run', action)
      }
    }
  } catch (error) {
    logger.error('probe transition notification failed: %o', error)
  } finally {
    if (claimed) {
      try {
        await cache.deleteKey(PROBE_ALERT_CLAIM_KEY)
      } catch (error) {
        logger.error('probe alert claim could not be released: %o', error)
      }
    }
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
