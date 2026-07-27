import { PostAdminLogoutController } from '../../controllers/admin/post-logout-controller'
import { IController } from '../../@types/controllers'
import { createAdminAuthProvider } from '../admin-auth-provider-factory'

export const createPostAdminLogoutController = (): IController => {
  return new PostAdminLogoutController(createAdminAuthProvider())
}
