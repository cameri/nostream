import { INotificationOutboxRepository } from '../@types/repositories'
import { INotificationDispatcher, INotificationOutboxService } from '../@types/services'
import { createLogger } from '../factories/logger-factory'

const logger = createLogger('notification-outbox-service')

export const NOTIFICATION_OUTBOX_BATCH_SIZE = 20
export const NOTIFICATION_OUTBOX_MAX_ATTEMPTS = 5

export class NotificationOutboxService implements INotificationOutboxService {
  public constructor(
    private readonly outboxRepository: INotificationOutboxRepository,
    private readonly dispatcher: INotificationDispatcher,
    private readonly maxAttempts: () => number = () => NOTIFICATION_OUTBOX_MAX_ATTEMPTS,
  ) {}

  public async processBatch(limit = NOTIFICATION_OUTBOX_BATCH_SIZE): Promise<number> {
    const messages = await this.outboxRepository.claimBatch(limit)

    if (!messages.length) {
      return 0
    }

    let delivered = 0

    for (const message of messages) {
      try {
        await this.dispatcher.dispatch(message.eventType, message.payload, {
          outboxId: message.id,
          attemptNumber: message.attemptCount + 1,
        })
        await this.outboxRepository.markDelivered(message.id)
        delivered++
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        logger.error('notification outbox delivery failed for %s: %s', message.id, reason)
        await this.outboxRepository.markFailed(
          message.id,
          reason,
          message.attemptCount + 1,
          this.maxAttempts(),
        )
      }
    }

    return delivered
  }
}
