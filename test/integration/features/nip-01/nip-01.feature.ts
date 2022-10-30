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
import { getDbClient } from '../../../../src/database/client'
import { MessageType } from '../../../../src/@types/messages'
import { serializeEvent } from '../../../../src/utils/event'
import { SubscriptionFilter } from '../../../../src/@types/subscription'

chai.use(sinonChai)
const { expect } = chai

Before(async function () {
  this.parameters.identities = {}
  this.parameters.subscriptions = {}
  this.parameters.clients = {}
  this.parameters.events = {}
})

After(async function () {
  this.parameters.events = {}
  this.parameters.subscriptions = {}
  Object.values(this.parameters.clients).forEach((ws: WebSocket) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close()
    }
  })
  this.parameters.clients = {}

  const dbClient = getDbClient()
  await Promise.all(
    Object.values(this.parameters.identities)
      .map(async (identity: { pubkey: string }) => dbClient('events').where({ event_pubkey: Buffer.from(identity.pubkey, 'hex') }).del())
  )
  this.parameters.identities = {}
})

Given(/someone called (\w+)/, async function(name: string) {
  const connection = connect(name)
  this.parameters.identities[name] = this.parameters.identities[name] ?? createIdentity(name)
  this.parameters.clients[name] = await connection
  this.parameters.subscriptions[name] = []
  this.parameters.events[name] = []
})

When(/(\w+) subscribes to author (\w+)$/, async function(this: World<Record<string, any>>, from: string, to: string) {
  const ws = this.parameters.clients[from] as WebSocket
  const pubkey = this.parameters.identities[to].pubkey
  const subscription = { name: `test-${Math.random()}`, filters: [{ authors: [pubkey] }] }
  this.parameters.subscriptions[from].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

When(/(\w+) subscribes to last event from (\w+)$/, async function(this: World<Record<string, any>>, from: string, to: string) {
  const ws = this.parameters.clients[from] as WebSocket
  const event = this.parameters.events[to].pop()
  const subscription = { name: `test-${Math.random()}`, filters: [{ ids: [event.id] }] }
  this.parameters.subscriptions[from].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

When(/(\w+) subscribes to author (\w+) with a limit of (\d+)/, async function(this: World<Record<string, any>>, from: string, to: string, limit: string) {
  const ws = this.parameters.clients[from] as WebSocket
  const pubkey = this.parameters.identities[to].pubkey
  const subscription = { name: `test-${Math.random()}`, filters: [{ authors: [pubkey], limit: Number(limit) }] }
  this.parameters.subscriptions[from].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

When(/^(\w+) subscribes to text_note events$/, async function(this: World<Record<string, any>>, name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = { name: `test-${Math.random()}`, filters: [{ kinds: [1] }] }
  this.parameters.subscriptions[name].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

When(/^(\w+) subscribes to text_note events from (\w+) and set_metadata events from (\w+)$/, async function(this: World<Record<string, any>>, name: string, author1: string, author2: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const firstAuthor = this.parameters.identities[author1].pubkey
  const secondAuthor = this.parameters.identities[author2].pubkey
  const subscription = {
    name: `test-${Math.random()}`,
    filters: [
      { kinds: [1], authors: [firstAuthor] },
      { kinds: [0], authors: [secondAuthor] },
    ],
  }
  this.parameters.subscriptions[name].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

When(/(\w+) subscribes to any event since (\d+) until (\d+)/, async function(this: World<Record<string, any>>, name: string, since: string, until: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = { name: `test-${Math.random()}`, filters: [{ since: Number(since), until: Number(until) }] }
  this.parameters.subscriptions[name].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

When(/(\w+) subscribes to tag (\w) with "(.*?)"$/, async function(this: World<Record<string, any>>, name: string, tag: string, value: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = { name: `test-${Math.random()}`, filters: [{ [`#${tag}`]: [value] }] }
  this.parameters.subscriptions[name].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)

  await waitForEOSE(ws, subscription.name)
})

When(/(\w+) sends a set_metadata event/, async function(name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const content = JSON.stringify({ name })
  const event: Event = await createEvent({ pubkey, kind: 0, content }, privkey)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(/^(\w+) sends a text_note event with content "([^"]+)"$/, async function(name: string, content: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 1, content }, privkey)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(/^(\w+) sends a text_note event with content "([^"]+)" and tag (\w) containing "([^"]+)"$/, async function(
  name: string,
  content: string,
  tag: string,
  value: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 1, content, tags: [[tag, value]] }, privkey)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(/^(\w+) sends a text_note event with content "([^"]+)" on (\d+)$/, async function(
  name: string,
  content: string,
  createdAt: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 1, content, created_at: Number(createdAt) }, privkey)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(/(\w+) sends a text_note event with invalid signature/, async function(name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 1, content: "I'm cheating" }, privkey)

  event.sig = 'f'.repeat(128)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(/(\w+) sends a recommend_server event with content "(.+?)"/, async function(name: string, content: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 2, content }, privkey)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

Then(/(\w+) receives a set_metadata event from (\w+)/, async function(name: string, author: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const receivedEvent = await waitForNextEvent(ws, subscription.name)

  expect(receivedEvent.kind).to.equal(0)
  expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
})

Then(/(\w+) receives a text_note event from (\w+) with content "([^"]+?)"/, async function(name: string, author: string, content: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const receivedEvent = await waitForNextEvent(ws, subscription.name)

  expect(receivedEvent.kind).to.equal(1)
  expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
  expect(receivedEvent.content).to.equal(content)
})

Then(/(\w+) receives a text_note event from (\w+) with content "(.+?)" on (\d+)/, async function(
  name: string,
  author: string,
  content: string,
  createdAt: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const receivedEvent = await waitForNextEvent(ws, subscription.name)

  expect(receivedEvent.kind).to.equal(1)
  expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
  expect(receivedEvent.content).to.equal(content)
  expect(receivedEvent.created_at).to.equal(Number(createdAt))
})

Then(/(\w+) receives (\d+) text_note events from (\w+)/, async function(
  name: string,
  count: string,
  author: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(events.length).to.equal(2)
  expect(events[0].kind).to.equal(1)
  expect(events[1].kind).to.equal(1)
  expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)
  expect(events[1].pubkey).to.equal(this.parameters.identities[author].pubkey)
})

Then(/(\w+) receives (\d+) events from (\w+) and (\w+)/, async function(
  name: string,
  count: string,
  author1: string,
  author2: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  console.log(events)
  expect(events.length).to.equal(2)
  expect(events[0].kind).to.equal(1)
  expect(events[1].kind).to.equal(0)
  expect(events[0].pubkey).to.equal(this.parameters.identities[author1].pubkey)
  expect(events[1].pubkey).to.equal(this.parameters.identities[author2].pubkey)
})

Then(/(\w+) receives a recommend_server event from (\w+) with content "(.+?)"/, async function(name: string, author: string, content: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const receivedEvent = await waitForNextEvent(ws, subscription.name)

  expect(receivedEvent.kind).to.equal(2)
  expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
  expect(receivedEvent.content).to.equal(content)
})

Then(/(\w+) receives a notice with (.*)/, async function(name: string, pattern: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const actualNotice = await waitForNotice(ws)

  expect(actualNotice).to.contain(pattern)
})

async function connect(_name: string) {
  const host = 'ws://localhost:8008'
  const ws = new WebSocket(host)
  await new Promise<void>((resolve, reject) => {
    ws
      // .on('message', (data: RawData) => {
      //   console.log(`${name} received`, JSON.parse(data.toString('utf-8')))
      // })
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

async function createEvent(input: Partial<Event>, privkey: any): Promise<Event> {
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
      const message = JSON.parse(raw.toString('utf-8'))
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

async function waitForEventCount(
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
      const message = JSON.parse(raw.toString('utf-8'))
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

async function waitForNotice(ws: WebSocket): Promise<void> {
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
      if (message[0] === MessageType.NOTICE) {
        resolve(message[1])
        cleanup()
      }
    }

    ws.on('message', onMessage)
  })
}