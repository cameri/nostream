import { GetAdminMetricsController } from '../../controllers/admin/get-metrics-controller'
import { IController } from '../../@types/controllers'

export const createGetAdminMetricsController = (): IController => {
  return new GetAdminMetricsController()
}
