import http from 'http'
import process from 'process'
import { WebSocketServer } from 'ws'

import { AppWorker } from '../app/worker'
import { createSettings } from '../factories/settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { getDbClient } from '../database/client'
import { webSocketAdapterFactory } from './websocket-adapter-factory'
import { WebSocketServerAdapter } from '../adapters/web-socket-server-adapter'

export const workerFactory = (): AppWorker => {
  const dbClient = getDbClient()
  const eventRepository = new EventRepository(dbClient)

  // deepcode ignore HttpToHttps: we use proxies
  const server = http.createServer()
  const webSocketServer = new WebSocketServer({
    server,
    maxPayload: 131072, // 128 kB
  })
  const adapter = new WebSocketServerAdapter(
    server,
    webSocketServer,
    webSocketAdapterFactory(eventRepository),
    createSettings,
  )

  return new AppWorker(process, adapter)
}
