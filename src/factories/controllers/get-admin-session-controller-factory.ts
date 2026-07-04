import { GetAdminSessionController } from '../../controllers/admin/get-session-controller'
import { IController } from '../../@types/controllers'
import { createAdminAuthProvider } from '../admin-auth-provider-factory'

export const createGetAdminSessionController = (): IController => {
  return new GetAdminSessionController(createAdminAuthProvider())
}
