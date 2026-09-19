import { Request, Response } from 'express'

import { IController } from '../../@types/controllers'
import { INotificationDeliveryLogRepository } from '../../@types/repositories'

export class GetAdminNotificationDeliveryLogController implements IController {
  public constructor(private readonly deliveryLogRepository: INotificationDeliveryLogRepository) {}

  public async handleRequest(_request: Request, response: Response): Promise<void> {
    const limit = Math.min(Number(_request.query.limit) || 50, 200)
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
