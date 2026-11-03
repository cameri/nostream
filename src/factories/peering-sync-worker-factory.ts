import { PeeringSyncWorker } from '../app/peering-sync-worker'
import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { UserRepository } from '../repositories/user-repository'
import { PeeringSyncStateStore } from '../utils/peering-sync-state'
import { createAdminOpsCacheAdapter } from './admin-ops-cache-adapter-factory'
import { createEventRepository } from './event-repository-factory'
import { createSettings } from './settings-factory'

export const peeringSyncWorkerFactory = () => {
  const cache = createAdminOpsCacheAdapter()
  const dbClient = getMasterDbClient()
  const eventRepository = createEventRepository(dbClient, getReadReplicaDbClient())
  const userRepository = new UserRepository(dbClient, eventRepository)

  return new PeeringSyncWorker(process, createSettings, eventRepository, {
    ...(cache ? { opsCache: cache, stateStore: new PeeringSyncStateStore(cache) } : {}),
    userRepository,
  })
}
