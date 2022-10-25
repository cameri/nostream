import { AppWorker } from '../app/worker'
import { EventRepository } from '../repositories/event-repository'
import { getDbClient } from '../database/client'

export const workerFactory = () => {
  const dbClient = getDbClient()
  const eventRepository = new EventRepository(dbClient)

  return new AppWorker(
    eventRepository
  )
}
