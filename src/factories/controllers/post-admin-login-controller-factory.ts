import { PostAdminLoginController } from '../../controllers/admin/post-login-controller'
import { IController } from '../../@types/controllers'
import { createAdminAuthProvider } from '../admin-auth-provider-factory'

export const createPostAdminLoginController = (): IController => {
  return new PostAdminLoginController(createAdminAuthProvider())
}
