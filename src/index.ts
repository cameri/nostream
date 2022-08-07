import * as http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { applySpec, prop, pipe } from 'ramda'
import Joi from 'joi'

import { createNotice, createOutgoingEventMessage } from './messages'
import packageJson from '../package.json'
import { Settings } from './settings'
import { Message, MessageType } from './types/messages'
import { SubscriptionFilter, SubscriptionId } from './types/subscription'
import { getDbClient } from './database/client'
import { messageSchema } from './schemas/message-schema'
import { Event } from './types/event'

const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 30000

const server = http.createServer()
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
const dbClient = getDbClient()

dbClient.raw('SELECT 1=1').then(() => void 0)

const stripEscape = (flerp) => flerp.slice(3)

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

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) {
      return
    }
    console.log(
      `broadcasting to client with subscriptions`,
      (client as any).subscriptions,
      nostrEvent,
    )
    Object.entries(
      (client as any).subscriptions as {
        [subscriptionId: SubscriptionId]: SubscriptionFilter
      },
    ).forEach(([subscriptionId]) => {
      client.send(
        JSON.stringify(createOutgoingEventMessage(subscriptionId, nostrEvent)),
      )
    })
  })
})

function heartbeat() {
  this.isAlive = true
}

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

wss.on('connection', (ws, _req) => {
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
      console.error('Invalid message', error)
      ws.send(
        JSON.stringify(createNotice('Message does not match any known schema')),
      )
      return
    }

    const command = message[0]
    switch (command) {
      case MessageType.EVENT:
        {
          if (message[1] === null || typeof message[1] !== 'object') {
            ws.send(JSON.stringify(createNotice(`Invalid event`)))
            return
          }

          const toJSON = (input) => JSON.stringify(input)
          const toBuffer = (input) => Buffer.from(input, 'hex')

          const row = applySpec({
            event_id: pipe(prop('id'), toBuffer),
            event_pubkey: pipe(prop('pubkey'), toBuffer),
            event_created_at: prop('created_at'),
            event_kind: prop('kind'),
            event_tags: pipe(prop('tags'), toJSON),
            event_content: prop('content'),
            event_signature: pipe(prop('sig'), toBuffer),
          })(message[1])

          dbClient('events')
            .insert(row)
            .onConflict('event_id')
            .ignore()
            .asCallback(function (error, rows) {
              if (error) {
                console.log('Unable to add event', error)
                return
              }
              console.log(`Added ${rows.length} events.`)
            })
        }
        break
      case MessageType.REQ:
        {
          const subscriptionId = message[1] as SubscriptionId
          const filter = message[2] as SubscriptionFilter

          const exists = subscriptionId in ws['subscriptions']

          ws['subscriptions'][subscriptionId] = filter

          console.log(
            `Subscription ${subscriptionId} ${
              exists ? 'updated' : 'created'
            } with filters ${JSON.stringify(filter)}`,
          )

          // TODO: search for matching events on the DB, then send ESOE

          // ws.send(
          //   JSON.stringify(
          //     createNotice(
          //       `Subscription ${subscriptionId} ${
          //         exists ? 'updated' : 'created'
          //       } with filters ${JSON.stringify(filter)}`,
          //     ),
          //   ),
          // )
        }
        break
      case MessageType.CLOSE:
        {
          const subscriptionId = message[1] as SubscriptionId

          const exists = subscriptionId in ws['subscriptions']
          if (!exists) {
            ws.send(
              JSON.stringify(
                createNotice(`Subscription ${subscriptionId} not found`),
              ),
            )
            return
          }

          delete ws['subscriptions'][subscriptionId]

          ws.send(
            JSON.stringify(
              createNotice(`Subscription ${subscriptionId} closed`),
            ),
          )
        }
        break
    }
  })

  ws.on('pong', heartbeat)

  ws.on('close', function onClose(code) {
    if (this.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(createNotice('Goodbye')))
    }
    console.log('disconnected %s', code)
  })

  ws.send(JSON.stringify(createNotice('Howdy!')))
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

server.on('clientError', (err, socket) => {
  if (err['code'] === 'ECONNRESET' || !socket.writable) {
    return
  }
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

const port = process.env.SERVER_PORT ?? 8008
console.log(`Listening on port: ${port}`)
server.listen(port)
