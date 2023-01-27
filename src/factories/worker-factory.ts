import { is, path, pathSatisfies } from 'ramda'
import express from 'express'
import helmet from 'helmet'
import http from 'http'
import process from 'process'
import { WebSocketServer } from 'ws'

import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { AppWorker } from '../app/worker'
import { createSettings } from '../factories/settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { rateLimiterMiddleware } from '../handlers/request-handlers/rate-limiter-middleware'
import router from '../routes'
import { UserRepository } from '../repositories/user-repository'
import { webSocketAdapterFactory } from './websocket-adapter-factory'
import { WebSocketServerAdapter } from '../adapters/web-socket-server-adapter'

export const workerFactory = (): AppWorker => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = new EventRepository(dbClient, readReplicaDbClient)
  const userRepository = new UserRepository(dbClient)

  const settings = createSettings()

  const app = express()
  app
    .disable('x-powered-by')
    .use(rateLimiterMiddleware)
    .use(helmet.contentSecurityPolicy({
      directives: {
        /**
         * TODO: Remove 'unsafe-inline'
         */
        'connect-src': [settings.info.relay_url as string],
        'default-src': ['"self"'],
        'script-src-attr': ["'unsafe-inline'"],
        'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/', 'https://cdnjs.cloudflare.com/ajax/libs/'],
        'style-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
        'font-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
      },
    }))
    .use('/favicon.ico', express.static('./resources/favicon.ico'))
    .use('/css', express.static('./resources/css'))
    .use(router)

  // deepcode ignore HttpToHttps: we use proxies
  const server = http.createServer(app)

  let maxPayloadSize: number | undefined
  if (pathSatisfies(is(String), ['network', 'max_payload_size'], settings)) {
    console.warn(`WARNING: Setting network.max_payload_size is deprecated and will be removed in a future version.
        Use network.maxPayloadSize instead.`)
    maxPayloadSize = path(['network', 'max_payload_size'], settings)
  } else {
    maxPayloadSize = path(['network', 'maxPayloadSize'], settings)
  }

  const webSocketServer = new WebSocketServer({
    server,
    maxPayload: maxPayloadSize ?? 131072, // 128 kB
  })
  const adapter = new WebSocketServerAdapter(
    server,
    webSocketServer,
    webSocketAdapterFactory(eventRepository, userRepository),
    createSettings,
  )

  return new AppWorker(process, adapter)
}
