import http from 'http'
import process from 'process'
import { WebSocketServer } from 'ws'

import { getMasterDbClient, getReadReplicaDbClient } from '../database/client'
import { AppWorker } from '../app/worker'
import { createSettings } from '../factories/settings-factory'
import { EventRepository } from '../repositories/event-repository'
import { webSocketAdapterFactory } from './websocket-adapter-factory'
import { WebSocketServerAdapter } from '../adapters/web-socket-server-adapter'

export const workerFactory = (): AppWorker => {
  const dbClient = getMasterDbClient()
  const readReplicaDbClient = getReadReplicaDbClient()
  const eventRepository = new EventRepository(dbClient, readReplicaDbClient)

  // deepcode ignore HttpToHttps: we use proxies
  const server = http.createServer()
  const webSocketServer = new WebSocketServer({
    server,
    maxPayload: createSettings().network?.max_payload_size ?? 131072, // 128 kB
  })
  const adapter = new WebSocketServerAdapter(
    server,
    webSocketServer,
    webSocketAdapterFactory(eventRepository),
    createSettings,
  )

  return new AppWorker(process, adapter)
}
