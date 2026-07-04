import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { createLogger } from '../../factories/logger-factory'
import { collectAdminMetricsSnapshot, getAdminMetricsSseIntervalMs } from '../../utils/admin-metrics'

const logger = createLogger('get-admin-metrics-controller')

export class GetAdminMetricsController implements IController {
  public async handleRequest(request: Request, response: Response): Promise<void> {
    response.status(200)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.flushHeaders()

    let closed = false
    let inFlight = false

    const sendSnapshot = async () => {
      if (closed || response.writableEnded || inFlight) {
        return
      }

      inFlight = true

      try {
        const snapshot = await collectAdminMetricsSnapshot()
        response.write(`data: ${JSON.stringify(snapshot)}\n\n`)
      } catch (error) {
        logger.warn('failed to collect admin metrics snapshot: %o', error)
        if (!closed && !response.writableEnded) {
          response.write(`event: error\ndata: ${JSON.stringify({ error: 'failed to collect metrics' })}\n\n`)
        }
      } finally {
        inFlight = false
      }
    }

    await sendSnapshot()

    const intervalMs = getAdminMetricsSseIntervalMs()
    const timer = setInterval(() => {
      void sendSnapshot()
    }, intervalMs)

    request.on('close', () => {
      closed = true
      clearInterval(timer)
    })
  }
}
