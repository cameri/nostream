import { GetAdminHealthController } from '../../controllers/admin/get-health-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminHealthController = (): IController => {
  return new GetAdminHealthController()
}
