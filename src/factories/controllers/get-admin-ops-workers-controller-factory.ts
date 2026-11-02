import { RedisAdapter } from '../../adapters/redis-adapter'
import { IController } from '../../@types/controllers'
import { getCacheClient } from '../../cache/client'
import { GetAdminOpsWorkersController } from '../../controllers/admin/get-ops-workers-controller'
import { AdminOpsStore } from '../../utils/admin-ops-store'

export const createGetAdminOpsWorkersController = (): IController => {
  const opsStore = new AdminOpsStore(new RedisAdapter(getCacheClient()))
  return new GetAdminOpsWorkersController(opsStore)
}
