import { PostAdminNotificationTestController } from '../../controllers/admin/post-notification-test-controller'
import { IController } from '../../@types/controllers'
import { createOperatorNotificationService } from '../notification-outbox-service-factory'

export const createPostAdminNotificationTestController = (): IController => {
  return new PostAdminNotificationTestController(createOperatorNotificationService())
}
