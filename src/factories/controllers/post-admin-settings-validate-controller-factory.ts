import { PostAdminSettingsValidateController } from '../../controllers/admin/post-settings-validate-controller'
import { IController } from '../../@types/controllers'

export const createPostAdminSettingsValidateController = (): IController => {
  return new PostAdminSettingsValidateController()
}
