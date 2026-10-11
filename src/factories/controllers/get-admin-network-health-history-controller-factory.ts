import { RedisAdapter } from '../../adapters/redis-adapter'
import { IController } from '../../@types/controllers'
import { getCacheClient } from '../../cache/client'
import { GetAdminNetworkHealthHistoryController } from '../../controllers/admin/get-network-health-history-controller'
import { RelayProbeHistoryStore } from '../../utils/relay-probe-history'

export const createGetAdminNetworkHealthHistoryController = (): IController => {
  const historyStore = new RelayProbeHistoryStore(new RedisAdapter(getCacheClient()))

  return new GetAdminNetworkHealthHistoryController(historyStore)
}
