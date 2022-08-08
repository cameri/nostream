import * as http from 'http'
import { WebSocketServer } from 'ws'

import { getDbClient } from './database/client'
import { EventRepository } from './repositories/event-repository'
import { WebSocketServerAdapter } from './adapters/web-socket-server-adapter'
import { SubscribeMessageHandler } from './handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from './handlers/unsubscribe-message-handler'
import { EventMessageHandler } from './handlers/event-message-handler'

const server = http.createServer()
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
const dbClient = getDbClient()
const eventRepository = new EventRepository(dbClient)

const adapter = new WebSocketServerAdapter(
  server,
  wss,
)
adapter.addMessageHandler(new SubscribeMessageHandler(eventRepository))
adapter.addMessageHandler(new UnsubscribeMessageHandler())
adapter.addMessageHandler(new EventMessageHandler(eventRepository))

const port = Number(process.env.SERVER_PORT) || 8008
adapter.listen(port)

process.on('SIGINT', function () {
  console.log('Caught interrupt signal')
  server.close()
  process.exit()
})
