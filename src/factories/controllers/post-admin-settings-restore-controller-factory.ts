import { PostAdminSettingsRestoreController } from '../../controllers/admin/post-settings-restore-controller'
import { IController } from '../../@types/controllers'

export const createPostAdminSettingsRestoreController = (): IController => {
  return new PostAdminSettingsRestoreController()
}
