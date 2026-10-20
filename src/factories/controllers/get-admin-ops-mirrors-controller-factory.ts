import { RedisAdapter } from '../../adapters/redis-adapter'
import { IController } from '../../@types/controllers'
import { getCacheClient } from '../../cache/client'
import { GetAdminOpsMirrorsController } from '../../controllers/admin/get-ops-mirrors-controller'
import { AdminOpsStore } from '../../utils/admin-ops-store'

export const createGetAdminOpsMirrorsController = (): IController => {
  const opsStore = new AdminOpsStore(new RedisAdapter(getCacheClient()))
  return new GetAdminOpsMirrorsController(opsStore)
}
