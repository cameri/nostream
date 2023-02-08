import * as secp256k1 from '@noble/secp256k1'
import { createHash, createHmac, Hash } from 'crypto'
import { Observable } from 'rxjs'
import WebSocket from 'ws'

import { CommandResult, MessageType, OutgoingAuthMessage, OutgoingMessage } from '../../../src/@types/messages'
import { Event } from '../../../src/@types/event'
import { serializeEvent } from '../../../src/utils/event'
import { streams } from './shared'
import { SubscriptionFilter } from '../../../src/@types/subscription'


secp256k1.utils.sha256Sync = (...messages: Uint8Array[]) =>
  messages.reduce((hash: Hash, message: Uint8Array) => hash.update(message),  createHash('sha256')).digest()

export async function connect(_name: string): Promise<WebSocket> {
  const host = 'ws://localhost:18808'
  const ws = new WebSocket(host)
  return new Promise<WebSocket>((resolve, reject) => {
    ws
      .once('open', () => {
        resolve(ws)
      })
      .once('error', reject)
      .once('close', () => {
        ws.removeAllListeners()
      })
  })
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

  const id = createHash('sha256').update(
    Buffer.from(JSON.stringify(serializeEvent(event)))
  ).digest().toString('hex')

  const sig = Buffer.from(
    secp256k1.schnorr.signSync(id, privkey)
  ).toString('hex')

  event.id = id
  event.sig = sig

  return event
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
    const data = JSON.stringify([
      'REQ',
      subscriptionName,
      ...subscriptionFilters,
    ])

    ws.send(data, (error?: Error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export async function waitForEOSE(ws: WebSocket, subscription: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    const sub = observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.EOSE && message[1] === subscription) {
        resolve()
        sub.unsubscribe()
      } else if (message[0] === MessageType.NOTICE) {
        reject(new Error(message[1]))
        sub.unsubscribe()
      }
    })
  })
}

export async function sendEvent(ws: WebSocket, event: Event, successful = true) {
  return new Promise<OutgoingMessage>((resolve, reject) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    const sub = observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.OK && message[1] === event.id) {
        if (message[2] === successful) {
          sub.unsubscribe()
          resolve(message)
        } else {
          sub.unsubscribe()
          reject(new Error(message[3]))
        }
      } else if (message[0] === MessageType.NOTICE) {
        sub.unsubscribe()
        reject(new Error(message[1]))
      }
    })

    ws.send(JSON.stringify(['EVENT', event]), (err) => {
      if (err) {
        sub.unsubscribe()
        reject(err)
      }
    })
  })
}

export async function waitForNextEvent(ws: WebSocket, subscription: string, content?: string): Promise<Event> {
  return new Promise((resolve, reject) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.EVENT && message[1] === subscription) {
        const event = message[2] as Event
        if (typeof content !== 'string' || event.content === content) {
          resolve(message[2])
        }
      } else if (message[0] === MessageType.NOTICE) {
        reject(new Error(message[1]))
      }
    })
  })
}

export async function waitForEventCount(
  ws: WebSocket,
  subscription: string,
  count = 1,
  eose = false,
): Promise<Event[]> {
  const events: Event[] = []

  return new Promise((resolve, reject) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.EVENT && message[1] === subscription) {
        events.push(message[2])
        if (!eose && events.length === count) {
          resolve(events)
        } else if (events.length > count) {
          reject(new Error(`Expected ${count} but got ${events.length} events`))
        }
      } else if (message[0] === MessageType.EOSE && message[1] === subscription) {
        if (!eose) {
          reject(new Error('Expected event but received EOSE'))
        } else if (events.length !== count) {
          reject(new Error(`Expected ${count} but got ${events.length} events before EOSE`))
        } else {
          resolve(events)
        }
      } else if (message[0] === MessageType.NOTICE) {
        reject(new Error(message[1]))
      }
    })
  })
}

export async function waitForNotice(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.NOTICE) {
        resolve(message[1])
      }
    })
  })
}

export async function waitForAuth(ws: WebSocket): Promise<OutgoingAuthMessage> {
  return new Promise<OutgoingAuthMessage>((resolve) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.AUTH) {
        resolve(message)
      }
    })
  })
}

export async function waitForCommand(ws: WebSocket): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    observable.subscribe((message: OutgoingMessage) => {
      if (message[0] === MessageType.OK) {
        resolve(message)
      }
    })
  })
}
