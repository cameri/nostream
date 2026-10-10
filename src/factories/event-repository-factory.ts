import { createSettings } from './settings-factory'
import { DatabaseClient } from '../@types/base'
import { EventRepository } from '../repositories/event-repository'
import { EventStoreBackend } from '../constants/base'
import { getEventStoreBackend } from '../utils/event-store'
import { IEventRepository } from '../@types/repositories'
import { Settings } from '../@types/settings'

export const createEventRepository = (
  masterDbClient: DatabaseClient,
  readReplicaDbClient: DatabaseClient,
  settings: () => Settings = createSettings,
): IEventRepository => {
  const backend = getEventStoreBackend(settings())

  switch (backend) {
    case EventStoreBackend.POSTGRES:
      return new EventRepository(masterDbClient, readReplicaDbClient, settings)
    default: {
      // exhaustiveness check
      const unhandled: never = backend
      throw new Error(`No event repository is available for eventStore.backend "${unhandled}"`)
    }
  }
}
