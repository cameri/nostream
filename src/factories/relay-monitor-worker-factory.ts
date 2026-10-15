import { RedisAdapter } from '../adapters/redis-adapter'
import { RelayMonitorWorker } from '../app/relay-monitor-worker'
import { getCacheClient } from '../cache/client'
import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createEventRepository } from './event-repository-factory'
import { createSettings } from './settings-factory'
import { Nip66EventPublisher } from '../services/nip66-event-publisher'
import { RelayProbeSnapshotStore } from '../utils/relay-probe-snapshot'
import { runProbe } from '../utils/relay-probe'

export const relayMonitorWorkerFactory = () => {
  const cache = new RedisAdapter(getCacheClient())
  const snapshotStore = new RelayProbeSnapshotStore(cache)
  const eventRepository = createEventRepository(getMasterDbClient(), getReadReplicaDbClient())
  const eventPublisher = new Nip66EventPublisher(eventRepository, cache)

  return new RelayMonitorWorker(process, createSettings, snapshotStore, runProbe, eventPublisher)
}
