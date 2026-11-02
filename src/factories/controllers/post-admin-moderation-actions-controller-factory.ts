import { PostAdminModerationActionsController } from '../../controllers/admin/post-moderation-actions-controller'
import { IController } from '../../@types/controllers'
import { getMasterDbClient } from '../../database/client'
import { NotificationOutboxRepository } from '../../repositories/notification-outbox-repository'

export const createPostAdminModerationActionsController = (): IController => {
  const notificationOutboxRepository = new NotificationOutboxRepository(getMasterDbClient())
  return new PostAdminModerationActionsController(notificationOutboxRepository)
}
