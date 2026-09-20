import { PatchAdminSettingsController } from '../../controllers/admin/patch-settings-controller'
import { IController } from '../../@types/controllers'
import { getMasterDbClient } from '../../database/client'
import { NotificationOutboxRepository } from '../../repositories/notification-outbox-repository'

export const createPatchAdminSettingsController = (): IController => {
  const notificationOutboxRepository = new NotificationOutboxRepository(getMasterDbClient())
  return new PatchAdminSettingsController(notificationOutboxRepository)
}
