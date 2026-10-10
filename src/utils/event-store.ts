import cluster from 'cluster'

import { EventStoreBackend } from '../constants/base'
import { Settings } from '../@types/settings'

// Set by the primary on every worker it forks.
export const EVENT_STORE_BACKEND_ENV = 'EVENT_STORE_BACKEND'

export const EVENT_STORE_BACKENDS: readonly EventStoreBackend[] = Object.values(EventStoreBackend)

export const isEventStoreBackend = (value: unknown): value is EventStoreBackend =>
  EVENT_STORE_BACKENDS.includes(value as EventStoreBackend)

const toEventStoreBackend = (value: unknown, source: string): EventStoreBackend => {
  if (!isEventStoreBackend(value)) {
    throw new Error(`Unsupported ${source} "${String(value)}". Supported backends: ${EVENT_STORE_BACKENDS.join(', ')}`)
  }

  return value
}

export const getConfiguredEventStoreBackend = (settings: Settings): EventStoreBackend =>
  toEventStoreBackend(settings.eventStore?.backend ?? EventStoreBackend.POSTGRES, 'eventStore.backend')

// Workers use the backend the primary resolved at startup; other processes read settings.
export const getEventStoreBackend = (settings: Settings): EventStoreBackend => {
  const inherited = cluster.isWorker ? process.env[EVENT_STORE_BACKEND_ENV] : undefined

  return inherited === undefined
    ? getConfiguredEventStoreBackend(settings)
    : toEventStoreBackend(inherited, EVENT_STORE_BACKEND_ENV)
}
