import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createSettings } from './settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { StaticMirroringWorker } from '../app/static-mirroring-worker'
import { UserRepository } from '../repositories/user-repository'

export const staticMirroringWorkerFactory = () => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = new EventRepository(dbClient, readReplicaDbClient)
  const userRepository = new UserRepository(dbClient)

  return new StaticMirroringWorker(
    eventRepository,
    userRepository,
    process,
    createSettings,
  )
}
