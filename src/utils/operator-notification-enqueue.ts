import { DatabaseClient } from '../@types/base'
import { NotificationOutboxPayload } from '../@types/notification-outbox'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { INotificationOutboxRepository } from '../@types/repositories'
import { getMasterDbClient } from '../database/client'
import { createLogger } from '../factories/logger-factory'
import { NotificationOutboxRepository } from '../repositories/notification-outbox-repository'

const logger = createLogger('operator-notification-enqueue')

let outboxRepository: INotificationOutboxRepository | undefined

const getOutboxRepository = (): INotificationOutboxRepository => {
  if (!outboxRepository) {
    outboxRepository = new NotificationOutboxRepository(getMasterDbClient())
  }

  return outboxRepository
}

export const enqueueOperatorNotification = async (
  eventType: OperatorNotificationEventType | string,
  payload: NotificationOutboxPayload,
  client?: DatabaseClient,
): Promise<void> => {
  try {
    await getOutboxRepository().enqueue(eventType, payload, client)
  } catch (error) {
    logger.error('Unable to enqueue operator notification %s', eventType, error)
  }
}
