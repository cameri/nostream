import * as secp256k1 from '@noble/secp256k1'
import {
  After,
  Before,
  Given,
  Then,
  When,
  World,
} from '@cucumber/cucumber'
import { RawData, WebSocket } from 'ws'
import chai from 'chai'
import { createHmac } from 'crypto'
import sinonChai from 'sinon-chai'

import { Event } from '../../../../src/@types/event'
import { MessageType } from '../../../../src/@types/messages'
import { serializeEvent } from '../../../../src/utils/event'
import { SubscriptionFilter } from '../../../../src/@types/subscription'

chai.use(sinonChai)
const { expect } = chai

Before(async function () {
  const ws = new WebSocket('ws://localhost:8008')
  this.parameters.ws = ws
  await new Promise((resolve, reject) => {
    ws
      .once('open', resolve)
      .once('error', reject)
  })
})

After(function () {
  const ws = this.parameters.ws as WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close()
  }
})

Given(/I am (\w+)/, function(name: string) {
  this.parameters.authors = this.parameters.authors ?? {}
  this.parameters.authors[name] = this.parameters.authors[name] ?? createIdentity(name)
})

When(/I subscribe to author (\w+)/, async function(this: World<Record<string, any>>, name: string) {
  const ws = this.parameters.ws as WebSocket
  const pubkey = this.parameters.authors[name].pubkey
  this.parameters.subscriptions = this.parameters.subscriptions ?? []
  const subscription = { name: `test-${Math.random()}`, filters: [{ authors: [pubkey] }] }
  this.parameters.subscriptions.push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)

  await waitForEOSE(ws, subscription.name)
})

When(/I send a set_metadata event as (\w+)/, async function(name: string) {
  const ws = this.parameters.ws as WebSocket
  const { pubkey, privkey } = this.parameters.authors[name]

  const content = JSON.stringify({ name })
  const event: Event = await createEvent({ pubkey, kind: 0, content }, privkey)

  await sendEvent(ws, event)

  this.parameters.events = this.parameters.events ?? []
  this.parameters.events.push(event)
})

Then(/I receive a set_metadata event from (\w+)/, async function(author: string) {
  const expectedEvent = this.parameters.events.pop()
  const subscription = this.parameters.subscriptions[this.parameters.subscriptions.length - 1]
  const receivedEvent = await waitForNextEvent(this.parameters.ws, subscription.name)
  expect(receivedEvent.pubkey).to.equal(this.parameters.authors[author].pubkey)
  expect(receivedEvent).to.deep.equal(expectedEvent)
})

async function createEvent(input: Partial<Event>, privkey: any): Promise<Event> {
  const event: Event = {
    pubkey: input.pubkey,
    kind: input.kind,
    created_at: input.created_at ?? Math.floor(Date.now() / 1000),
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

function createIdentity(name: string) {
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

async function createSubscription(
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

async function waitForEOSE(ws: WebSocket, subscription: string): Promise<void> {
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
      const message = JSON.parse(raw.toString('utf-8'))
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

async function sendEvent(ws: WebSocket, event: Event) {
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

async function waitForNextEvent(ws: WebSocket, subscription: string): Promise<Event> {
  return new Promise((resolve, reject) => {
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
      ws.removeListener('error', onError)
      const message = JSON.parse(raw.toString('utf-8'))
      if (message[0] === MessageType.EVENT && message[1] === subscription) {
        resolve(message[2])
        cleanup()
      } else if (message[0] === MessageType.NOTICE) {
        reject(new Error(message[1]))
        cleanup()
      }
    }
    ws.on('message', onMessage)
  })
}