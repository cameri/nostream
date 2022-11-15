import {
  Then,
  When,
  World,
} from '@cucumber/cucumber'
import chai from 'chai'
import sinonChai from 'sinon-chai'
import { WebSocket } from 'ws'

import {
  createEvent,
  createSubscription,
  sendEvent,
  waitForCommand,
  waitForEOSE,
  waitForEventCount,
  waitForNextEvent,
  waitForNotice,
} from '../helpers'
import { Event } from '../../../../src/@types/event'

chai.use(sinonChai)
const { expect } = chai

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

Then(/(\w+) receives an? (\w+) result/, async function(name: string, successful: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const command = await waitForCommand(ws)

  expect(command[2]).to.equal(successful === 'successful')
})
