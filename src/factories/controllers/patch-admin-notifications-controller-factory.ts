import { PatchAdminNotificationsController } from '../../controllers/admin/patch-notifications-controller'
import { IController } from '../../@types/controllers'
import { getMasterDbClient } from '../../database/client'
import { NotificationOutboxRepository } from '../../repositories/notification-outbox-repository'

export const createPatchAdminNotificationsController = (): IController => {
  const notificationOutboxRepository = new NotificationOutboxRepository(getMasterDbClient())
  return new PatchAdminNotificationsController(notificationOutboxRepository)
}
