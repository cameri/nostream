import { RedisAdapter } from '../../adapters/redis-adapter'
import { IController } from '../../@types/controllers'
import { getCacheClient } from '../../cache/client'
import { GetAdminNetworkHealthController } from '../../controllers/admin/get-network-health-controller'
import { RelayProbeSnapshotStore } from '../../utils/relay-probe-snapshot'

export const createGetAdminNetworkHealthController = (): IController => {
  const snapshotStore = new RelayProbeSnapshotStore(new RedisAdapter(getCacheClient()))

  return new GetAdminNetworkHealthController(snapshotStore)
}
