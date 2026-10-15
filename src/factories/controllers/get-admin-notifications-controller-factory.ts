import { GetAdminNotificationsController } from '../../controllers/admin/get-notifications-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminNotificationsController = (): IController => {
  return new GetAdminNotificationsController()
}
