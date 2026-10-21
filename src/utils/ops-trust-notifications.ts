import { ICacheAdapter } from '../@types/adapters'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { RelayProbeRunSnapshot } from '../@types/relay-probe-snapshot'
import { createLogger } from '../factories/logger-factory'
import { enqueueOperatorNotification } from './operator-notification-enqueue'

const logger = createLogger('ops-trust-notifications')

const PROBE_STATUS_KEY = 'admin:trust:probe:last_status'
const SSL_ALERT_PREFIX = 'admin:trust:ssl:alert:'
const MIRROR_DISCONNECT_PREFIX = 'admin:trust:mirror:disconnect:'

const SSL_EXPIRY_WARNING_DAYS = 14
const DEDUPE_TTL_SECONDS = 6 * 3600
const PROBE_STATUS_TTL_SECONDS = 86400 * 30

/** Atomically read previous probe status, persist the new status, return alert action. */
const PROBE_TRANSITION_SCRIPT = `
local prev = redis.call('GET', KEYS[1]) or ''
local current = ARGV[1]
local ttl = tonumber(ARGV[2])
local action = ''
if prev ~= '' and (prev == 'failed' or prev == 'partial') and current == 'ok' then
  action = 'recovered'
elseif current ~= 'ok' and prev ~= current then
  action = 'failed'
end
redis.call('SET', KEYS[1], current, 'EX', ttl)
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

  try {
    const action = String(
      (await cache.eval(PROBE_TRANSITION_SCRIPT, [PROBE_STATUS_KEY], [
        snapshot.status,
        String(PROBE_STATUS_TTL_SECONDS),
      ])) ?? '',
    )

    if (action === 'recovered') {
      const enqueued = await enqueueTrustNotification(OperatorNotificationEventType.PROBE_RECOVERED, {
        runAt: snapshot.runAt,
        status: snapshot.status,
        targets: snapshot.targets,
      })
      if (!enqueued) {
        logger.error('probe recovered notification was not enqueued')
      }
    } else if (action === 'failed') {
      const enqueued = await enqueueTrustNotification(OperatorNotificationEventType.PROBE_FAILED, {
        runAt: snapshot.runAt,
        status: snapshot.status,
        targets: snapshot.targets,
      })
      if (!enqueued) {
        logger.error('probe failed notification was not enqueued')
      }
    }

    await notifySslExpiringFromSnapshot(cache, snapshot)
  } catch (error) {
    logger.error('probe transition notification failed: %o', error)
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

export const notifyMirrorDisconnected = async (
  cache: ICacheAdapter | undefined,
  fields: { index: string; targetUrl: string; code?: number; reason?: string },
): Promise<void> => {
  if (!cache) {
    return
  }

  const dedupeKey = `${MIRROR_DISCONNECT_PREFIX}${fields.index}`
  try {
    await sendDedupedTrustNotification(cache, dedupeKey, OperatorNotificationEventType.MIRROR_DISCONNECTED, {
      index: fields.index,
      targetUrl: fields.targetUrl,
      code: fields.code,
      reason: fields.reason,
    })
  } catch (error) {
    logger.error('mirror disconnected notification failed: %o', error)
  }
}
