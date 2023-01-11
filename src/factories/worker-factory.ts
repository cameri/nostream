import express from 'express'
import helmet from 'helmet'
import http from 'http'
import process from 'process'
import { WebSocketServer } from 'ws'

import { AppWorker } from '../app/worker'
import { createPaymentsProcessor } from './payments-processor-factory'
import { createSettings } from '../factories/settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { getDbClient } from '../database/client'
import router from '../routes'
import { slidingWindowRateLimiterFactory } from './rate-limiter-factory'
import { webSocketAdapterFactory } from './websocket-adapter-factory'
import { WebSocketServerAdapter } from '../adapters/web-socket-server-adapter'

export const workerFactory = (): AppWorker => {
  const dbClient = getDbClient()
  const eventRepository = new EventRepository(dbClient)

  const app = express()
  app
    .disable('x-powered-by')
    .use(  helmet.contentSecurityPolicy({
      directives: {
        /**
         * TODO: Remove 'unsafe-inline'
         */
        'script-src-attr': ["'unsafe-inline'"],
        'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/', 'https://cdnjs.cloudflare.com/ajax/libs/'],
        'style-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
        'font-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
      },
    }))
    .use('/favicon.ico', express.static('./resources/favicon.ico'))
    .use('/css', express.static('./resources/css'))
    .use((req, _res, next) => {
      req['paymentsProcessor'] = createPaymentsProcessor()
      next()
    })
    .use(router)

  // deepcode ignore HttpToHttps: we use proxies
  const server = http.createServer(app)

  const settings = createSettings()

  let maxPayloadSize: number | undefined
  if (settings.network['max_payload_size']) {
    console.warn(`WARNING: Setting network.max_payload_size is deprecated and will be removed in a future version.
        Use network.maxPayloadSize instead.`)
    maxPayloadSize = settings.network['max_payload_size']
  } else {
    maxPayloadSize = settings.network.maxPayloadSize
  }

  const webSocketServer = new WebSocketServer({
    server,
    maxPayload: maxPayloadSize ?? 131072, // 128 kB
  })
  const adapter = new WebSocketServerAdapter(
    server,
    webSocketServer,
    webSocketAdapterFactory(eventRepository),
    slidingWindowRateLimiterFactory,
    createSettings,
  )

  return new AppWorker(process, adapter)
}
