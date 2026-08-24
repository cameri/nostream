import process from 'process'

import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createSettings } from './settings-factory'
import { DvmJobRepository } from '../repositories/dvm-job-repository'
import { DvmOrchestratorWorker } from '../app/dvm-orchestrator-worker'
import { EventRepository } from '../repositories/event-repository'

export const dvmOrchestratorWorkerFactory = () => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const dvmJobRepository = new DvmJobRepository(dbClient)
  const eventRepository = new EventRepository(dbClient, readReplicaDbClient, createSettings)

  return new DvmOrchestratorWorker(process, createSettings, dvmJobRepository, eventRepository)
}
