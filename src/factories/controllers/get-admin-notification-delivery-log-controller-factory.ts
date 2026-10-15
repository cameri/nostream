import { GetAdminNotificationDeliveryLogController } from '../../controllers/admin/get-notification-delivery-log-controller'
import { IController } from '../../@types/controllers'
import { getMasterDbClient } from '../../database/client'
import { NotificationDeliveryLogRepository } from '../../repositories/notification-delivery-log-repository'

export const createGetAdminNotificationDeliveryLogController = (): IController => {
  return new GetAdminNotificationDeliveryLogController(new NotificationDeliveryLogRepository(getMasterDbClient()))
}
