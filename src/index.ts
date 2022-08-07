import * as http from 'http'
import { WebSocketServer } from 'ws'
import { getDbClient } from './database/client'
import { EventRepository } from './repositories/event-repository'
import { WebSocketServerAdapter } from './relay/web-socket-server-adapter'
import { SubscribeMessageHandler } from './handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from './handlers/unsubscribe-message-handler'
import { EventMessageHandler } from './handlers/event-message-handler'

// const inspect = (myObject) =>
//   util.inspect(myObject, { showHidden: false, depth: null, colors: true })

// const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 30000

const server = http.createServer()
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
const dbClient = getDbClient()
const eventRepository = new EventRepository(dbClient)

const adapter = new WebSocketServerAdapter(
  server,
  wss,
)
adapter.addMessageHandler(new SubscribeMessageHandler(adapter, eventRepository))
adapter.addMessageHandler(new UnsubscribeMessageHandler(adapter))
adapter.addMessageHandler(new EventMessageHandler(adapter, eventRepository))

// const subscriptions = new WeakMap<
//   WebSocket,
//   Map<SubscriptionId, SubscriptionFilter[]>
// >()

// function broadcastEvent(event: Event) {
//   wss.clients.forEach((ws) => {
//     if (ws.readyState !== WebSocket.OPEN) {
//       return
//     }
//     subscriptions.get(ws)?.forEach((filters, subscriptionId) => {
//       if (
//         !filters.map(isEventMatchingFilter).some((isMatch) => isMatch(event))
//       ) {
//         return
//       }

//       console.log('Event sent', event.id)

//       ws.send(
//         JSON.stringify(createOutgoingEventMessage(subscriptionId, event))
//       )
//     })
//   })
// }

// function heartbeat() {
//   this.isAlive = true
// }

// wss.on('connection', function (ws, _req) {
//   subscriptions.set(ws, new Map())
//   ws['isAlive'] = true

//   ws.on('message', function onMessage(raw) {
//     let message: Message

//     try {
//       message = Joi.attempt(JSON.parse(raw.toString('utf8')), messageSchema, {
//         stripUnknown: true,
//         abortEarly: true,
//       }) as Message
//     } catch (error) {
//       console.error('Invalid message', error, raw.toString('utf8'))
//       return
//     }

//     const command = message[0]
//     switch (command) {
//       case MessageType.EVENT:
//         {
//           eventRepository.create(message[1]).then(
//             (count) => {
//               if (!count) {
//                 console.debug('Event already exists.')
//                 return
//               }
//               broadcastEvent(message[1] as Event)
//             },
//             (error) => {
//               console.error(`Unable to add event. Reason: ${error.message}`)
//             }
//           )
//         }
//         break
//       case MessageType.REQ:
//         {
//           const subscriptionId = message[1] as SubscriptionId
//           const filters = message.slice(2) as SubscriptionFilter[]

//           const exists = subscriptions.get(ws)?.get(subscriptionId)

//           subscriptions.get(ws)?.set(subscriptionId, filters)

//           console.log(
//             `Subscription ${subscriptionId} ${exists ? 'updated' : 'created'
//             } with filters:`,
//             inspect(filters)
//           )

//           // TODO: search for matching events on the DB, then send ESOE

//           eventRepository.findByfilters(filters).then(
//             (events) => {
//               events.forEach((event) => {
//                 ws.send(
//                   JSON.stringify(
//                     createOutgoingEventMessage(subscriptionId, event)
//                   )
//                 )
//               })
//               console.debug(`Sent ${events.length} events to:`, subscriptionId)
//               ws.send(
//                 JSON.stringify(
//                   createEndOfStoredEventsNoticeMessage(subscriptionId)
//                 )
//               )
//               console.debug('Sent EOSE to:', subscriptionId)
//             },
//             (error) => {
//               console.error('Unable to find by filters: ', error)
//             }
//           )
//         }
//         break
//       case MessageType.CLOSE:
//         {
//           const subscriptionId = message[1] as SubscriptionId

//           subscriptions.get(ws)?.delete(subscriptionId)
//         }
//         break
//       case MessageType.EOSE:
//         break
//     }
//   })

//   ws.on('pong', heartbeat)

//   ws.on('close', function onClose(code) {
//     const clientSubs = subscriptions.get(this)
//     clientSubs?.clear()
//     if (clientSubs) {
//       subscriptions.delete(this)
//     }
//     console.log('disconnected %s', code)
//   })
// })

// const heartbeatInterval = setInterval(function ping() {
//   wss.clients.forEach(function each(ws) {
//     if (!ws['isAlive']) {
//       return ws.terminate()
//     }

//     ws['isAlive'] = false
//     ws.ping()
//   })
// }, WSS_CLIENT_HEALTH_PROBE_INTERVAL)

// wss.on('close', function close() {
//   clearInterval(heartbeatInterval)
// })

// server.on('request', async (req, res) => {
//   if (req.headers['accept'] === 'application/nostr+json') {
//     const {
//       info: { name, description, pubkey, contact },
//     } = Settings

//     const relayInformationDocument = {
//       name,
//       description,
//       pubkey,
//       contact,
//       supported_nips: [11],
//       software: packageJson.repository.url,
//       version: packageJson.version,
//     }

//     res.setHeader('content-type', 'application/nostr+json')
//     res.end(JSON.stringify(relayInformationDocument))
//   } else {
//     res.end()
//   }
// })

// server.on('clientError', (err, socket) => {
//   if (err['code'] === 'ECONNRESET' || !socket.writable) {
//     return
//   }
//   socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
// })

const port = Number(process.env.SERVER_PORT) || 8008
adapter.listen(port)
// console.log(`Listening on port: ${port}`)
// server.listen(port)

process.on('SIGINT', function () {
  console.log('Caught interrupt signal')
  server.close()
  process.exit()
})
