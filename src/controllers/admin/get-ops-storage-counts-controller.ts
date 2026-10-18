import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { IEventRepository } from '../../@types/repositories'
import {
  ADMIN_OPS_STORAGE_QUERY_TIMEOUT_MS,
  buildStorageCountFilters,
  parseAdminOpsStorageQuery,
} from '../../utils/admin-ops-storage'
import { delayMs } from '../../utils/misc'

export class GetAdminOpsStorageCountsController implements IController {
  public constructor(private readonly eventRepository: IEventRepository) {}

  public async handleRequest(request: Request, response: Response): Promise<void> {
    const parsed = parseAdminOpsStorageQuery(request.query.kinds, request.query.since, request.query.until)
    if (parsed.error || !parsed.query) {
      response.status(400).setHeader('content-type', 'application/json').send({ error: parsed.error ?? 'Invalid query' })
      return
    }

    const filters = buildStorageCountFilters(parsed.query)

    try {
      const counts = await Promise.race([
        Promise.all(
          filters.map(async (filter) => ({
            kinds: filter.kinds ?? [],
            count: await this.eventRepository.countByFilters([filter]),
          })),
        ),
        delayMs(ADMIN_OPS_STORAGE_QUERY_TIMEOUT_MS).then(() => {
          throw new Error('storage count query timed out')
        }),
      ])

      response.status(200).setHeader('content-type', 'application/json').send({
        since: parsed.query.since,
        until: parsed.query.until,
        counts,
      })
    } catch {
      response.status(504).setHeader('content-type', 'application/json').send({ error: 'Storage count query timed out' })
    }
  }
}
