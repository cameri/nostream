import { GetAdminSettingsBackupsController } from '../../controllers/admin/get-settings-backups-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminSettingsBackupsController = (): IController => {
  return new GetAdminSettingsBackupsController()
}
