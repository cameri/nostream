import { createMaintenanceService } from './maintenance-service-factory'
import { createNotificationOutboxService } from './notification-outbox-service-factory'
import { createPaymentsService } from './payments-service-factory'
import { createSettings } from './settings-factory'
import { getMasterDbClient } from '../database/client'
import { MaintenanceWorker } from '../app/maintenance-worker'
import { NotificationDeliveryLogRepository } from '../repositories/notification-delivery-log-repository'
import { NotificationOutboxRepository } from '../repositories/notification-outbox-repository'
import { Nip05VerificationRepository } from '../repositories/nip05-verification-repository'

export const maintenanceWorkerFactory = () => {
  const dbClient = getMasterDbClient()
  const nip05VerificationRepository = new Nip05VerificationRepository(dbClient)
  const notificationDeliveryLogRepository = new NotificationDeliveryLogRepository(dbClient)
  const notificationOutboxRepository = new NotificationOutboxRepository(dbClient)
  return new MaintenanceWorker(
    process,
    createPaymentsService(),
    createMaintenanceService(),
    createSettings,
    nip05VerificationRepository,
    createNotificationOutboxService(),
    notificationDeliveryLogRepository,
    notificationOutboxRepository,
  )
}
