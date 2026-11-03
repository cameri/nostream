import { IController } from '../../@types/controllers'
import { RedisAdapter } from '../../adapters/redis-adapter'
import { getCacheClient } from '../../cache/client'
import { GetAdminPeeringController } from '../../controllers/admin/get-admin-peering-controller'
import { PeeringSyncStateStore } from '../../utils/peering-sync-state'

export const createGetAdminPeeringController = (): IController => {
  const stateStore = new PeeringSyncStateStore(new RedisAdapter(getCacheClient()))

  return new GetAdminPeeringController(stateStore)
}
