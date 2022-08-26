import * as http from 'http'
import { WebSocketServer } from 'ws'

import { EventRepository } from './repositories/event-repository'
import { getDbClient } from './database/client'
import { webSocketAdapterFactory } from './factories/websocket-adapter-factory'
import { WebSocketServerAdapter } from './adapters/web-socket-server-adapter'

const server = http.createServer()
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
const dbClient = getDbClient()
const eventRepository = new EventRepository(dbClient)

const adapter = new WebSocketServerAdapter(
  server,
  wss,
  webSocketAdapterFactory(eventRepository)
)

const port = Number(process.env.SERVER_PORT) || 8008
adapter.listen(port)

process.on('SIGINT', async function () {
  console.log('\rCaught interrupt signal')
  wss.clients.forEach((client) => client.terminate())
  await new Promise((resolve, reject) =>
    wss.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined))
  )
  await new Promise((resolve, reject) =>
    server.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined))
  )
  dbClient.destroy()
  process.exit()
})
