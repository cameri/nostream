import { GetAdminSettingsController } from '../../controllers/admin/get-settings-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminSettingsController = (): IController => {
  return new GetAdminSettingsController()
}
