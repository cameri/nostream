import { PatchAdminSettingsController } from '../../controllers/admin/patch-settings-controller'
import { IController } from '../../@types/controllers'

export const createPatchAdminSettingsController = (): IController => {
  return new PatchAdminSettingsController()
}
