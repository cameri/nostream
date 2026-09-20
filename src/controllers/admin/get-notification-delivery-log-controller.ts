import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { INotificationDeliveryLogRepository } from '../../@types/repositories'

export class GetAdminNotificationDeliveryLogController implements IController {
  public constructor(private readonly deliveryLogRepository: INotificationDeliveryLogRepository) {}

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    let limit = 50
    if (_request.query.limit !== undefined) {
      const parsed = Number(_request.query.limit)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        response.status(400).setHeader('content-type', 'application/json').send({
          error: 'limit must be a positive integer',
        })
        return
      }
      limit = Math.min(parsed, 200)
    }

    const entries = await this.deliveryLogRepository.findRecent(limit)

    response.status(200).setHeader('content-type', 'application/json').send({
      entries: entries.map((entry) => ({
        id: entry.id,
        outboxId: entry.outboxId,
        eventType: entry.eventType,
        targetId: entry.targetId,
        targetType: entry.targetType,
        status: entry.status,
        attemptNumber: entry.attemptNumber,
        errorSnippet: entry.errorSnippet,
        createdAt: entry.createdAt.toISOString(),
      })),
    })
  }
}
