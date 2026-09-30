import http from 'http'
import process from 'process'
import { is, path, pathSatisfies } from 'ramda'
import { WebSocketServer } from 'ws'
import { WebSocketServerAdapter } from '../adapters/web-socket-server-adapter'
import { AppWorker } from '../app/worker'
import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { createSettings } from '../factories/settings-factory'
import { DvmJobRepository } from '../repositories/dvm-job-repository'
import { EventRepository } from '../repositories/event-repository'
import { InviteCodeRepository } from '../repositories/invite-code-repository'
import { Nip05VerificationRepository } from '../repositories/nip05-verification-repository'
import { ReportRepository } from '../repositories/report-repository'
import { UserRepository } from '../repositories/user-repository'
import { startHiddenContentCache } from '../utils/hidden-content-cache'
import { createLogger } from './logger-factory'
import { getCache } from './message-handler-factory'
import { createWebApp } from './web-app-factory'
import { webSocketAdapterFactory } from './websocket-adapter-factory'
import { wotGraphServiceFactory } from './wot-graph-service-factory'

const logger = createLogger('worker-factory')

export const workerFactory = (): AppWorker => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = new EventRepository(dbClient, readReplicaDbClient, createSettings)
  const userRepository = new UserRepository(dbClient, eventRepository)
  const nip05VerificationRepository = new Nip05VerificationRepository(dbClient)
  const inviteCodeRepository = new InviteCodeRepository(dbClient)
  const dvmJobRepository = new DvmJobRepository(dbClient)
  const reportRepository = new ReportRepository(dbClient)

  const settings = createSettings()

  // NIP-56: starts the hidden-content cache (polls Postgres directly, every
  // worker independently -- see hidden-content-cache.ts) as early in boot as
  // possible, before any other setup, so it has the largest possible head
  // start on server.listen() below. Fire-and-forget, same reasoning as
  // WotGraphService's warm-up: making worker boot itself wait on this would
  // require every IRunnable worker type's bootstrap to become async, which
  // is out of scope here. The narrow startup race this leaves (a live
  // subscriber could see unfiltered content in the brief window before this
  // resolves) self-heals on the cache's own periodic refresh, not a
  // dedicated retry path.
  if (settings.nip56?.enabled) {
    startHiddenContentCache(reportRepository, createSettings).catch((error) =>
      logger.error('failed to start hidden content cache: %o', error),
    )
  }

  // Constructs the WoT graph singleton (and starts warming it up, if enabled)
  // right at worker boot -- before this call, the singleton was only ever
  // created lazily inside per-event handler wiring, so the very first
  // EVENT/report needing a WoT distance was also the thing paying for the
  // cold-start rebuild the warm-up was meant to avoid.
  wotGraphServiceFactory(getCache(), eventRepository, createSettings)

  const app = createWebApp()

  // deepcode ignore HttpToHttps: we use proxies
  const server = http.createServer(app)

  let maxPayloadSize: number | undefined
  if (pathSatisfies(is(String), ['network', 'max_payload_size'], settings)) {
    logger.warn(`WARNING: Setting network.max_payload_size is deprecated and will be removed in a future version.
        Use network.maxPayloadSize instead.`)
    maxPayloadSize = path(['network', 'max_payload_size'], settings)
  } else {
    maxPayloadSize = path(['network', 'maxPayloadSize'], settings)
  }

  const webSocketServer = new WebSocketServer({
    server,
    maxPayload: maxPayloadSize ?? 131072, // 128 kB
    perMessageDeflate: {
      zlibDeflateOptions: {
        chunkSize: 1024,
        memLevel: 7,
        level: 3,
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024,
      },
      clientNoContextTakeover: true, // Defaults to negotiated value.
      serverNoContextTakeover: true, // Defaults to negotiated value.
      serverMaxWindowBits: 10, // Defaults to negotiated value.
      // Below options specified as default values.
      concurrencyLimit: 10, // Limits zlib concurrency for perf.
      threshold: 1024, // Size (in bytes) below which messages
      // should not be compressed if context takeover is disabled.
    },
  })
  const adapter = new WebSocketServerAdapter(
    server,
    webSocketServer,
    webSocketAdapterFactory(
      eventRepository,
      userRepository,
      nip05VerificationRepository,
      inviteCodeRepository,
      dvmJobRepository,
      reportRepository,
    ),
    createSettings,
  )

  return new AppWorker(process, adapter)
}
