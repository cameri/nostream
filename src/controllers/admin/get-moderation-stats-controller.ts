import { Request, Response } from 'express'

import { RedisAdapter } from '../../adapters/redis-adapter'
import { IController } from '../../@types/controllers'
import { getCacheClient, isCacheConfigured } from '../../cache/client'
import { getReadReplicaDbClient } from '../../database/client'
import { createLogger } from '../../factories/logger-factory'
import {
  parseModerationStatsLimit,
  parseModerationStatsWindowHours,
  queryTopClientIps,
  queryTopPublishingPubkeys,
} from '../../utils/admin-moderation-stats'
import { listModerationRateLimitHits } from '../../utils/moderation-rate-limit-stats'

const logger = createLogger('get-admin-moderation-stats-controller')

const isStatsQueryTimeout = (error: unknown): boolean =>
  error instanceof Error && /query timeout|timed out/i.test(error.message)

export class GetAdminModerationStatsController implements IController {
  public async handleRequest(request: Request, response: Response): Promise<void> {
    const window = parseModerationStatsWindowHours(request.query.windowHours)
    if (window.error || window.hours === undefined) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: window.error })
      return
    }

    const limit = parseModerationStatsLimit(request.query.limit)
    const sinceUnixSeconds = Math.floor(Date.now() / 1000) - window.hours * 3600

    try {
      const [topPubkeys, topIps] = await Promise.all([
        queryTopPublishingPubkeys(getReadReplicaDbClient(), sinceUnixSeconds, limit),
        queryTopClientIps(getReadReplicaDbClient(), sinceUnixSeconds, limit),
      ])

      let rateLimitHits = { pubkeys: [] as { key: string; hits: number }[], ips: [] as { key: string; hits: number }[] }
      if (isCacheConfigured()) {
        const cache = new RedisAdapter(getCacheClient())
        rateLimitHits = await listModerationRateLimitHits(cache, limit, window.hours)
      }

      response.status(200).setHeader('content-type', 'application/json').send({
        windowHours: window.hours,
        since: sinceUnixSeconds,
        topPublishingPubkeys: topPubkeys,
        topClientIps: topIps,
        rateLimitHits,
      })
    } catch (error) {
      if (isStatsQueryTimeout(error)) {
        response.status(504).setHeader('content-type', 'application/json').send({ error: 'Moderation stats query timed out' })
        return
      }

      logger.error('moderation stats query failed: %o', error)
      response.status(500).setHeader('content-type', 'application/json').send({ error: 'Moderation stats query failed' })
    }
  }
}
