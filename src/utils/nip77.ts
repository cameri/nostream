import { EventStoreBackend } from '../constants/base'
import { getEventStoreBackend } from './event-store'
import { Settings } from '../@types/settings'

export const DEFAULT_MAX_EVENTS_PER_SESSION = 100000
export const DEFAULT_MAX_SESSIONS_PER_CONNECTION = 3
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60000

// Binary size of one negentropy message we send, before hex encoding. Larger answers are cut short
// and finished over further rounds. 60 kB matches strfry's default.
export const NEGENTROPY_FRAME_SIZE_LIMIT = 60000

// NIP-77 is served natively only from PostgreSQL; other backends (e.g. strfry) bring their own.
export const isNip77Active = (settings: Settings): boolean =>
  settings.nip77?.enabled === true && getEventStoreBackend(settings) === EventStoreBackend.POSTGRES

export const getNip77Limits = (settings: Settings) => ({
  maxEventsPerSession: settings.nip77?.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION,
  maxSessionsPerConnection: settings.nip77?.maxSessionsPerConnection ?? DEFAULT_MAX_SESSIONS_PER_CONNECTION,
  sessionIdleTimeoutMs: settings.nip77?.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
})
