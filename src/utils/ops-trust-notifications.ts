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
// Results parked while a claim is held are handled by the claim holder before it lets go; this bounds that chain.
const MAX_PROBE_TRANSITION_PASSES = 10

/**
 * Atomically compare the previous probe status with the new one and return the
 * alert to send, if any.
 *
 * - While a claim held by another run exists, this run's result is parked in a
 *   "pending" key (the latest one wins) and nothing is returned; the claim holder
 *   handles it before it lets go (see PROBE_FINISH_SCRIPT).
 * - A run that holds the claim itself (the token matches) continues with the
 *   result it took over, so results are handled in the order they were observed.
 * - When there is nothing to alert, the new status is stored right away.
 * - When there is an alert, the stored status is left unchanged and the claim is
 *   taken (or kept) with this run's token. The caller records the status only
 *   after the alert has been stored, so a failed save is retried by the next run
 *   instead of the transition being lost.
 */
const PROBE_TRANSITION_SCRIPT = `
local current = ARGV[1]
local ttl = tonumber(ARGV[2])
local claimTtl = tonumber(ARGV[3])
local token = ARGV[4]
local holder = redis.call('GET', KEYS[2])
if holder and holder ~= token then
  redis.call('SET', KEYS[3], ARGV[5], 'EX', claimTtl)
  return ''
end
if not holder then
  redis.call('DEL', KEYS[3])
end
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
 * Record the status (when the alert was stored), then either hand over a result
 * that another run parked or release the claim, in one step. Because the check
 * for a parked result and the release cannot be separated, no other run can slip
 * in between and be handled before an older result.
 *
 * Only acts while the claim still holds this run's token: if it expired and
 * another run took it, this run must not delete that run's claim or overwrite its
 * status. With ARGV[5] ~= '1' (the pass limit) the claim is released and a parked
 * result is left in place; the next run replaces it with its own, newer result.
 */
const PROBE_FINISH_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return ''
end
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
end
if ARGV[5] == '1' then
  local pending = redis.call('GET', KEYS[3])
  if pending then
    redis.call('DEL', KEYS[3])
    redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
    return pending
  end
end
redis.call('DEL', KEYS[2])
return ''
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

const probeKeys = [PROBE_STATUS_KEY, PROBE_ALERT_CLAIM_KEY, PROBE_PENDING_KEY]

const runTransitionScript = async (cache: ICacheAdapter, snapshot: ParkedProbeResult, token: string): Promise<string> =>
  String(
    (await cache.eval(PROBE_TRANSITION_SCRIPT, probeKeys, [
      snapshot.status,
      String(PROBE_STATUS_TTL_SECONDS),
      String(PROBE_ALERT_CLAIM_TTL_SECONDS),
      token,
      JSON.stringify({ status: snapshot.status, runAt: snapshot.runAt, targets: snapshot.targets }),
    ])) ?? '',
  )

/** Record the status if asked to, then hand over a parked result or release the claim. */
const runFinishScript = async (
  cache: ICacheAdapter,
  token: string,
  recordedStatus: string,
  handOver: boolean,
): Promise<ParkedProbeResult | undefined> =>
  parseParkedResult(
    await cache.eval(PROBE_FINISH_SCRIPT, probeKeys, [
      token,
      recordedStatus,
      String(PROBE_STATUS_TTL_SECONDS),
      String(PROBE_ALERT_CLAIM_TTL_SECONDS),
      handOver ? '1' : '0',
    ]),
  )

/**
 * Compare this run's result with the stored status and send the alert it calls for. A run that takes the
 * claim keeps it, together with any result another run parked meanwhile, until nothing is parked, so
 * results are handled in the order they were observed and none is dropped.
 */
const processProbeTransitions = async (cache: ICacheAdapter, snapshot: ParkedProbeResult): Promise<void> => {
  const token = randomUUID()
  let current: ParkedProbeResult = snapshot
  let holdingClaim = false

  try {
    for (let pass = 0; pass < MAX_PROBE_TRANSITION_PASSES; pass++) {
      const handOver = pass < MAX_PROBE_TRANSITION_PASSES - 1
      const action = await runTransitionScript(cache, current, token)

      let recordedStatus = ''
      if (action === 'recovered' || action === 'failed') {
        holdingClaim = true
        const eventType =
          action === 'recovered'
            ? OperatorNotificationEventType.PROBE_RECOVERED
            : OperatorNotificationEventType.PROBE_FAILED

        let enqueued = false
        try {
          enqueued = await enqueueTrustNotification(eventType, {
            runAt: current.runAt,
            status: current.status,
            targets: current.targets,
          })
        } catch (error) {
          logger.error('probe %s notification failed: %o', action, error)
        }

        if (enqueued) {
          // Only now is the transition recorded, so a failed enqueue is retried by the next run.
          recordedStatus = current.status
        } else {
          logger.error('probe %s notification was not enqueued; it will be retried on the next run', action)
        }
      } else if (!holdingClaim) {
        // Nothing to alert (the status is stored) or another run holds the claim (this result is parked).
        return
      }

      const parked = await runFinishScript(cache, token, recordedStatus, handOver)
      if (!parked) {
        holdingClaim = false
        return
      }

      current = parked
    }
  } catch (error) {
    logger.error('probe transition notification failed: %o', error)
    if (holdingClaim) {
      try {
        await runFinishScript(cache, token, '', false)
      } catch (releaseError) {
        logger.error('probe alert claim could not be released: %o', releaseError)
      }
    }
  }
}

export const notifyProbeRunTransition = async (
  cache: ICacheAdapter | undefined,
  snapshot: RelayProbeRunSnapshot,
): Promise<void> => {
  if (!cache) {
    return
  }

  await processProbeTransitions(cache, snapshot)

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
