import { PeeringSyncWorker } from '../app/peering-sync-worker'
import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { PeeringSyncStateStore } from '../utils/peering-sync-state'
import { createAdminOpsCacheAdapter } from './admin-ops-cache-adapter-factory'
import { createEventRepository } from './event-repository-factory'
import { createSettings } from './settings-factory'

export const peeringSyncWorkerFactory = () => {
  const cache = createAdminOpsCacheAdapter()
  const eventRepository = createEventRepository(getMasterDbClient(), getReadReplicaDbClient())

  return new PeeringSyncWorker(process, createSettings, eventRepository, {
    ...(cache ? { opsCache: cache, stateStore: new PeeringSyncStateStore(cache) } : {}),
  })
}
