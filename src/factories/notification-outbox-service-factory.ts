import { createSettings } from './settings-factory'
import { getMasterDbClient } from '../database/client'
import { NotificationDeliveryLogRepository } from '../repositories/notification-delivery-log-repository'
import { NotificationOutboxRepository } from '../repositories/notification-outbox-repository'
import { NotificationOutboxService } from '../services/notification-outbox-service'
import { OperatorNotificationService } from '../services/operator-notification-service'

export const createOperatorNotificationService = () => {
  const deliveryLogRepository = new NotificationDeliveryLogRepository(getMasterDbClient())
  return new OperatorNotificationService(createSettings, deliveryLogRepository)
}

export const createNotificationOutboxService = () => {
  const outboxRepository = new NotificationOutboxRepository(getMasterDbClient())
  const operatorNotificationService = createOperatorNotificationService()
  return new NotificationOutboxService(
    outboxRepository,
    operatorNotificationService,
    () => operatorNotificationService.getMaxAttempts(),
  )
}
