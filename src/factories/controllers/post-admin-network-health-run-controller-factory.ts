import { RedisAdapter } from '../../adapters/redis-adapter'
import { IController } from '../../@types/controllers'
import { getCacheClient } from '../../cache/client'
import { PostAdminNetworkHealthRunController } from '../../controllers/admin/post-admin-network-health-run-controller'
import { createSettings } from '../settings-factory'
import { RelayProbeHistoryStore } from '../../utils/relay-probe-history'
import { RelayProbeSnapshotStore } from '../../utils/relay-probe-snapshot'

export const createPostAdminNetworkHealthRunController = (): IController => {
  const cacheAdapter = new RedisAdapter(getCacheClient())
  const snapshotStore = new RelayProbeSnapshotStore(cacheAdapter)
  const historyStore = new RelayProbeHistoryStore(cacheAdapter)

  return new PostAdminNetworkHealthRunController(
    snapshotStore,
    createSettings,
    undefined,
    historyStore,
    cacheAdapter,
  )
}
