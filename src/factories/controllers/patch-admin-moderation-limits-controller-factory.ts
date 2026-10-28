import { PatchAdminModerationLimitsController } from '../../controllers/admin/patch-moderation-limits-controller'
import { IController } from '../../@types/controllers'
import { getMasterDbClient } from '../../database/client'
import { NotificationOutboxRepository } from '../../repositories/notification-outbox-repository'

export const createPatchAdminModerationLimitsController = (): IController => {
  const notificationOutboxRepository = new NotificationOutboxRepository(getMasterDbClient())
  return new PatchAdminModerationLimitsController(notificationOutboxRepository)
}
