import { IController } from '../../@types/controllers'
import { RedisAdapter } from '../../adapters/redis-adapter'
import { getCacheClient } from '../../cache/client'
import { GetAdminPeeringController } from '../../controllers/admin/get-admin-peering-controller'
import { PeeringRequestStatsStore } from '../../utils/peering-request-stats'
import { PeeringSyncStateStore } from '../../utils/peering-sync-state'

export const createGetAdminPeeringController = (): IController => {
  // The RedisAdapter constructor attaches connection listeners. Reusing one
  // adapter keeps repeated dashboard polls from stacking listeners on the
  // shared cache client.
  if (!sharedController) {
    const cache = new RedisAdapter(getCacheClient())
    const stateStore = new PeeringSyncStateStore(cache)
    const requestStatsStore = new PeeringRequestStatsStore(cache)
    sharedController = new GetAdminPeeringController(stateStore, undefined, requestStatsStore)
  }

  return sharedController
}

let sharedController: IController | undefined
