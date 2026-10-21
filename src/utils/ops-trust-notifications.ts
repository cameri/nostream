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

const isFailedStatus = (status: RelayProbeRunSnapshot['status']): boolean =>
  status === 'failed' || status === 'partial'

export const notifyProbeRunTransition = async (
  cache: ICacheAdapter | undefined,
  snapshot: RelayProbeRunSnapshot,
): Promise<void> => {
  if (!cache) {
    return
  }

  const previous = (await cache.getKey(PROBE_STATUS_KEY)) || ''
  const current = snapshot.status

  try {
    if (previous && isFailedStatus(previous as RelayProbeRunSnapshot['status']) && current === 'ok') {
      await enqueueOperatorNotification(OperatorNotificationEventType.PROBE_RECOVERED, {
        runAt: snapshot.runAt,
        status: current,
        targets: snapshot.targets,
      })
    } else if (current !== 'ok' && previous !== current) {
      await enqueueOperatorNotification(OperatorNotificationEventType.PROBE_FAILED, {
        runAt: snapshot.runAt,
        status: current,
        targets: snapshot.targets,
      })
    }

    await cache.setKey(PROBE_STATUS_KEY, current, 86400 * 30)
  } catch (error) {
    logger.error('probe transition notification failed: %o', error)
  }

  await notifySslExpiringFromSnapshot(cache, snapshot)
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
    const alreadySent = await cache.hasKey(dedupeKey)
    if (alreadySent) {
      continue
    }

    try {
      await enqueueOperatorNotification(OperatorNotificationEventType.SSL_EXPIRING, {
        relayUrl,
        expiresAt,
        daysRemaining: Math.ceil(remainingMs / 86400000),
      })
      await cache.setKey(dedupeKey, '1', DEDUPE_TTL_SECONDS)
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
  if (await cache.hasKey(dedupeKey)) {
    return
  }

  try {
    await enqueueOperatorNotification(OperatorNotificationEventType.MIRROR_DISCONNECTED, {
      index: fields.index,
      targetUrl: fields.targetUrl,
      code: fields.code,
      reason: fields.reason,
    })
    await cache.setKey(dedupeKey, '1', DEDUPE_TTL_SECONDS)
  } catch (error) {
    logger.error('mirror disconnected notification failed: %o', error)
  }
}
