import * as http from 'http'
import { WebSocketServer } from 'ws'

import { getDbClient } from './database/client'
import { EventRepository } from './repositories/event-repository'
import { WebSocketServerAdapter } from './adapters/web-socket-server-adapter'
import { webSocketAdapterFactory } from './factories/websocket-adapter-factory'

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
  await new Promise((resolve, reject) => wss.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined)))
  await new Promise((resolve, reject) => server.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined)))
  dbClient.destroy()
  process.exit()
})
