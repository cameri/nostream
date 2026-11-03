import { IController } from '../../@types/controllers'
import { RedisAdapter } from '../../adapters/redis-adapter'
import { getCacheClient } from '../../cache/client'
import { GetAdminPeeringController } from '../../controllers/admin/get-admin-peering-controller'
import { PeeringSyncStateStore } from '../../utils/peering-sync-state'

export const createGetAdminPeeringController = (): IController => {
  // The RedisAdapter constructor attaches connection listeners. Reusing one
  // adapter keeps repeated dashboard polls from stacking listeners on the
  // shared cache client.
  if (!sharedController) {
    const stateStore = new PeeringSyncStateStore(new RedisAdapter(getCacheClient()))
    sharedController = new GetAdminPeeringController(stateStore)
  }

  return sharedController
}

let sharedController: IController | undefined
