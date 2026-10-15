import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createEventRepository } from './event-repository-factory'
import { createSettings } from './settings-factory'
import { StaticMirroringWorker } from '../app/static-mirroring-worker'
import { UserRepository } from '../repositories/user-repository'

export const staticMirroringWorkerFactory = () => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = createEventRepository(dbClient, readReplicaDbClient)
  const userRepository = new UserRepository(dbClient, eventRepository)

  return new StaticMirroringWorker(eventRepository, userRepository, process, createSettings)
}
