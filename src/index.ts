import * as http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { applySpec, prop, pipe } from 'ramda'
import Joi from 'joi'
import util from 'util'

import {
  createEndOfStoredEventsNoticeMessage,
  createOutgoingEventMessage,
} from './messages'
import packageJson from '../package.json'
import { Settings } from './settings'
import { Message, MessageType } from './types/messages'
import { SubscriptionFilter, SubscriptionId } from './types/subscription'
import { getDbClient } from './database/client'
import { messageSchema } from './schemas/message-schema'
import { Event } from './types/event'
import { isEventMatchingFilter } from './event'
import { EventRepository } from './repositories/event-repository'

const inspect = (myObject) =>
  util.inspect(myObject, { showHidden: false, depth: null, colors: true })

const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 30000

const server = http.createServer()
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
const dbClient = getDbClient()
const eventRepository = new EventRepository(dbClient)

dbClient.raw('SELECT 1=1').then(() => void 0)

const stripEscape = (flerp) => flerp.slice(2)

const createEventFromDb = applySpec({
  id: pipe(prop('event_id'), stripEscape),
  pubkey: pipe(prop('event_pubkey'), stripEscape),
  created_at: prop('event_created_at'),
  kind: prop('event_kind'),
  tags: prop('event_tags'),
  content: prop('event_content'),
  sig: pipe(prop('event_signature'), stripEscape),
})

dbClient.on('event_added', (event) => {
  const nostrEvent = createEventFromDb(event) as Event

  wss.clients.forEach((ws) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return
    }
    Object.entries(
      (ws as any).subscriptions as {
        [subscriptionId: SubscriptionId]: SubscriptionFilter[]
      },
    ).forEach(([subscriptionId, filters]) => {
      if (
        !filters
          .map(isEventMatchingFilter)
          .some((isMatch) => isMatch(nostrEvent))
      ) {
        return
      }
      console.log(
        `Broadcasting to client with subscription ${subscriptionId}`,
        inspect(filters),
        inspect(nostrEvent),
      )

      ws.send(
        JSON.stringify(createOutgoingEventMessage(subscriptionId, nostrEvent)),
      )
    })
  })
})

function heartbeat() {
  this.isAlive = true
}

wss.on('connection', function (ws, _req) {
  ws['subscriptions'] = {}
  ws['isAlive'] = true

  ws.on('message', function onMessage(raw) {
    let message: Message

    try {
      message = Joi.attempt(JSON.parse(raw.toString('utf8')), messageSchema, {
        stripUnknown: true,
        abortEarly: true,
      }) as Message
    } catch (error) {
      console.error('Invalid message', error, JSON.stringify(raw))
      return
    }

    const command = message[0]
    switch (command) {
      case MessageType.EVENT:
        {
          if (message[1] === null || typeof message[1] !== 'object') {
            // ws.send(JSON.stringify(createNotice(`Invalid event`)))
            return
          }

          eventRepository.create(message[1]).catch((error) => {
            console.error(`Unable to add event. Reason: ${error.message}`)
          })
        }
        break
      case MessageType.REQ:
        {
          const subscriptionId = message[1] as SubscriptionId
          const filters = message.slice(2) as SubscriptionFilter[]

          const exists = subscriptionId in ws['subscriptions']

          ws['subscriptions'][subscriptionId] = filters

          console.log(
            `Subscription ${subscriptionId} ${
              exists ? 'updated' : 'created'
            } with filters:`,
            inspect(filters),
          )

          // TODO: search for matching events on the DB, then send ESOE

          eventRepository.findByfilters(filters).then(
            (events) => {
              events.forEach((event) => {
                ws.send(
                  JSON.stringify(
                    createOutgoingEventMessage(subscriptionId, event),
                  ),
                )
              })
              ws.send(
                JSON.stringify(
                  createEndOfStoredEventsNoticeMessage(subscriptionId),
                ),
              )
              console.log(`Found ${events.length} events matching filter.`)
            },
            (error) => {
              console.error('Unable to find by filters: ', error)
            },
          )
        }
        break
      case MessageType.CLOSE:
        {
          const subscriptionId = message[1] as SubscriptionId
          delete ws['subscriptions'][subscriptionId]
        }
        break
    }
  })

  ws.on('pong', heartbeat)

  ws.on('close', function onClose(code) {
    Object.keys(ws['subscriptions']).forEach(
      (subscriptionId) => delete ws['subscriptions'][subscriptionId],
    )
    delete ws['subscriptions']
    // TODO: Clean up subscriptions
    console.log('disconnected %s', code)
  })
})

const heartbeatInterval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (!ws['isAlive']) {
      return ws.terminate()
    }

    ws['isAlive'] = false
    ws.ping()
  })
}, WSS_CLIENT_HEALTH_PROBE_INTERVAL)

wss.on('close', function close() {
  clearInterval(heartbeatInterval)
})

server.on('request', async (req, res) => {
  if (req.headers['accept'] === 'application/nostr+json') {
    const {
      info: { name, description, pubkey, contact },
    } = Settings

    const relayInformationDocument = {
      name,
      description,
      pubkey,
      contact,
      supported_nips: [11],
      software: packageJson.repository.url,
      version: packageJson.version,
    }

    res.setHeader('content-type', 'application/nostr+json')
    res.end(JSON.stringify(relayInformationDocument))
  } else {
    res.end()
  }
})

server.on('clientError', (err, socket) => {
  if (err['code'] === 'ECONNRESET' || !socket.writable) {
    return
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

const port = process.env.SERVER_PORT ?? 8008
console.log(`Listening on port: ${port}`)
server.listen(port)

process.on('SIGINT', function () {
  console.log('Caught interrupt signal')
  server.close()
  process.exit()
})
