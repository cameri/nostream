import process from 'process'

import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createEventRepository } from './event-repository-factory'
import { createSettings } from './settings-factory'
import { DvmJobRepository } from '../repositories/dvm-job-repository'
import { DvmOrchestratorWorker } from '../app/dvm-orchestrator-worker'

export const dvmOrchestratorWorkerFactory = () => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const dvmJobRepository = new DvmJobRepository(dbClient)
  const eventRepository = createEventRepository(dbClient, readReplicaDbClient)

  return new DvmOrchestratorWorker(process, createSettings, dvmJobRepository, eventRepository)
}
