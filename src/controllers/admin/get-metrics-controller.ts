import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { createLogger } from '../../factories/logger-factory'
import {
  collectAdminMetricsSnapshot,
  createUnavailableAdminMetricsSnapshot,
  getAdminMetricsSseIntervalMs,
} from '../../utils/admin-metrics'
import { delayMs } from '../../utils/misc'

const logger = createLogger('get-admin-metrics-controller')

const getAdminMetricsSnapshotTimeoutMs = (): number => {
  const timeoutCandidate = Number(process.env.ADMIN_METRICS_SNAPSHOT_TIMEOUT_MS)
  if (!Number.isFinite(timeoutCandidate) || timeoutCandidate < 1000) {
    return 10000
  }

  return timeoutCandidate
}

export class GetAdminMetricsController implements IController {
  public async handleRequest(request: Request, response: Response): Promise<void> {
    response.status(200)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.flushHeaders()

    let closed = false
    let inFlight = false
    let timer: ReturnType<typeof setInterval> | undefined

    const cleanup = () => {
      closed = true
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    }

    request.on('close', cleanup)

    const sendSnapshot = async () => {
      if (closed || response.writableEnded || inFlight) {
        return
      }

      inFlight = true

      try {
        const snapshot = await Promise.race([
          collectAdminMetricsSnapshot(),
          delayMs(getAdminMetricsSnapshotTimeoutMs()).then(() => {
            throw new Error('admin metrics snapshot timed out')
          }),
        ])
        if (closed || response.writableEnded) {
          return
        }

        response.write(`data: ${JSON.stringify(snapshot)}\n\n`)
      } catch (error) {
        logger.warn('failed to collect admin metrics snapshot: %o', error)
        if (!closed && !response.writableEnded) {
          const fallbackSnapshot = createUnavailableAdminMetricsSnapshot('failed to collect metrics')
          response.write(`data: ${JSON.stringify(fallbackSnapshot)}\n\n`)
        }
      } finally {
        inFlight = false
      }
    }

    await sendSnapshot()

    if (closed || response.writableEnded) {
      return
    }

    const intervalMs = getAdminMetricsSseIntervalMs()
    timer = setInterval(() => {
      void sendSnapshot()
    }, intervalMs)
  }
}
