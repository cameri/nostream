import * as secp256k1 from '@noble/secp256k1'
import WebSocket, { RawData } from 'ws'
import { createHmac } from 'crypto'

import { Event } from '../../../src/@types/event'
import { MessageType } from '../../../src/@types/messages'
import { serializeEvent } from '../../../src/utils/event'
import { SubscriptionFilter } from '../../../src/@types/subscription'


export async function connect(_name: string) {
  const host = 'ws://localhost:18808'
  const ws = new WebSocket(host)
  await new Promise<void>((resolve, reject) => {
    ws
      .once('open', () => {
        resolve()
      })
      .once('error', reject)
      .once('close', () => {
        ws.removeAllListeners()
      })
  })
  return ws
}

let eventCount = 0

export async function createEvent(input: Partial<Event>, privkey: any): Promise<Event> {
  const event: Event = {
    pubkey: input.pubkey,
    kind: input.kind,
    created_at: input.created_at ?? Math.floor(Date.now() / 1000) + eventCount++,
    content: input.content ?? '',
    tags: input.tags ?? [],
  } as any

  const id = Buffer.from(
    await secp256k1.utils.sha256(
      Buffer.from(JSON.stringify(serializeEvent(event)))
    )
  ).toString('hex')

  const sig = Buffer.from(
    await secp256k1.schnorr.sign(id, privkey)
  ).toString('hex')

  return { id, ...event, sig }
}

export function createIdentity(name: string) {
  const hmac = createHmac('sha256', process.env.SECRET ?? Math.random().toString())
  hmac.update(name)
  const privkey = hmac.digest().toString('hex')
  const pubkey = Buffer.from(secp256k1.getPublicKey(privkey, true)).toString('hex').substring(2)
  const author = {
    name,
    privkey,
    pubkey,
  }
  return author
}

export async function createSubscription(
  ws: WebSocket,
  subscriptionName: string,
  subscriptionFilters: SubscriptionFilter[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const message = JSON.stringify([
      'REQ',
      subscriptionName,
      ...subscriptionFilters,
    ])

    ws.send(message, (error: Error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

export async function waitForEOSE(ws: WebSocket, subscription: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      ws.removeListener('message', onMessage)
      ws.removeListener('error', onError)
    }

    function onError(error: Error) {
      reject(error)
      cleanup()
    }
    ws.once('error', onError)

    function onMessage(raw: RawData) {
      const message = JSON.parse(raw.toString('utf8'))
      if (message[0] === MessageType.EOSE && message[1] === subscription) {
        resolve()
        cleanup()
      } else if (message[0] === MessageType.NOTICE) {
        reject(new Error(message[1]))
        cleanup()
      }
    }

    ws.on('message', onMessage)
  })
}

export async function sendEvent(ws: WebSocket, event: Event) {
  return new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(['EVENT', event]), (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

export async function waitForNextEvent(ws: WebSocket, subscription: string): Promise<Event> {
  return new Promise((resolve, reject) => {
    ws.on('message', onMessage)
    ws.once('error', onError)

    function cleanup() {
      ws.removeListener('message', onMessage)
      ws.removeListener('error', onError)
    }

    function onError(error: Error) {
      reject(error)
      cleanup()
    }

    function onMessage(raw: RawData) {
      const message = JSON.parse(raw.toString('utf8'))
      if (message[0] === MessageType.EVENT && message[1] === subscription) {
        resolve(message[2])
        cleanup()
      } else if (message[0] === MessageType.NOTICE) {
        reject(new Error(message[1]))
        cleanup()
      }
    }
  })
}

export async function waitForEventCount(
  ws: WebSocket,
  subscription: string,
  count = 1,
  eose = false,
): Promise<Event[]> {
  const events = []

  return new Promise((resolve, reject) => {
    ws.on('message', onMessage)
    ws.once('error', onError)
    function cleanup() {
      ws.removeListener('message', onMessage)
      ws.removeListener('error', onError)
    }

    function onError(error: Error) {
      reject(error)
      cleanup()
    }
    function onMessage(raw: RawData) {
      const message = JSON.parse(raw.toString('utf8'))
      if (message[0] === MessageType.EVENT && message[1] === subscription) {
        events.push(message[2])
        if (!eose && events.length === count) {
          resolve(events)
          cleanup()
        } else if (events.length > count) {
          reject(new Error(`Expected ${count} but got ${events.length} events`))
          cleanup()
        }
      } else if (message[0] === MessageType.EOSE && message[1] === subscription) {
        if (!eose) {
          reject(new Error('Expected event but received EOSE'))
        } else if (events.length !== count) {
          reject(new Error(`Expected ${count} but got ${events.length} events before EOSE`))
        } else {
          resolve(events)
        }
        cleanup()
      } else if (message[0] === MessageType.NOTICE) {
        reject(new Error(message[1]))
        cleanup()
      }
    }
  })
}

export async function waitForNotice(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      ws.removeListener('message', onMessage)
      ws.removeListener('error', onError)
    }

    function onError(error: Error) {
      reject(error)
      cleanup()
    }
    ws.once('error', onError)

    function onMessage(raw: RawData) {
      const message = JSON.parse(raw.toString('utf8'))
      if (message[0] === MessageType.NOTICE) {
        resolve(message[1])
        cleanup()
      }
    }

    ws.on('message', onMessage)
  })
}

export async function waitForCommand(ws: WebSocket): Promise<any> {
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      ws.removeListener('message', onMessage)
      ws.removeListener('error', onError)
    }

    function onError(error: Error) {
      reject(error)
      cleanup()
    }
    ws.once('error', onError)

    function onMessage(raw: RawData) {
      const message = JSON.parse(raw.toString('utf8'))
      if (message[0] === MessageType.OK) {
        resolve(message)
        cleanup()
      }
    }

    ws.on('message', onMessage)
  })
}
