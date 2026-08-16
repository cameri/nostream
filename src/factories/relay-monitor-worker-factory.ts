import { RedisAdapter } from '../adapters/redis-adapter'
import { RelayMonitorWorker } from '../app/relay-monitor-worker'
import { getCacheClient } from '../cache/client'
import { createSettings } from './settings-factory'
import { RelayProbeSnapshotStore } from '../utils/relay-probe-snapshot'

export const relayMonitorWorkerFactory = () => {
  const snapshotStore = new RelayProbeSnapshotStore(new RedisAdapter(getCacheClient()))

  return new RelayMonitorWorker(process, createSettings, snapshotStore)
}
