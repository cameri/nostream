import { Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, sendEvent, waitForEventCount, waitForNextEvent } from '../helpers'
import { Event } from '../../../../src/@types/event'

When(/^(\w+) sends a replaceable_event_0 event with content "([^"]+)"$/, async function (
  name: string,
  content: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 10000, content }, privkey)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

Then(
  /(\w+) receives a replaceable_event_0 event from (\w+) with content "([^"]+?)"/,
  async function (name: string, author: string, content: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const receivedEvent = await waitForNextEvent(ws, subscription.name)

    expect(receivedEvent.kind).to.equal(10000)
    expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
    expect(receivedEvent.content).to.equal(content)
  })

Then(/(\w+) receives (\d+) replaceable_event_0 events? from (\w+) with content "([^"]+?)" and EOSE/, async function (
  name: string,
  count: string,
  author: string,
  content: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(events.length).to.equal(Number(count))
  expect(events[0].kind).to.equal(10000)
  expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)
  expect(events[0].content).to.equal(content)
})

When(/^(\w+) sends a ephemeral_event_0 event with content "([^"]+)"$/, async function (
  name: string,
  content: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 20000, content }, privkey)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

Then(
  /(\w+) receives a ephemeral_event_0 event from (\w+) with content "([^"]+?)"/,
  async function (name: string, author: string, content: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const receivedEvent = await waitForNextEvent(ws, subscription.name)

    expect(receivedEvent.kind).to.equal(20000)
    expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
    expect(receivedEvent.content).to.equal(content)
  })

Then(/(\w+) receives (\d+) ephemeral_event_0 events? and EOSE/, async function (
  name: string,
  count: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(events.length).to.equal(Number(count))
})

When(/^(\w+) sends two identically-timestamped replaceable_event_0 events where the second has a lower ID$/, async function (
  name: string
) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const commonTimestamp = Math.floor(Date.now() / 1000)

  const event1 = await createEvent({ pubkey, kind: 10000, content: 'first content', created_at: commonTimestamp }, privkey)

  let nonce = 0
  let event2: Event
  for (; ;) {
    event2 = await createEvent({ pubkey, kind: 10000, content: `second content ${nonce++}`, created_at: commonTimestamp }, privkey)

    if (event2.id < event1.id) {
      break
    }
  }

  await sendEvent(ws, event1)
  await sendEvent(ws, event2)

  this.parameters.events[name].push(event1, event2)
  this.parameters.lowerIdEventContent = event2.content
})

Then(/(\w+) receives (\d+) replaceable_event_0 event from (\w+) matching the lower ID event and EOSE/, async function (
  name: string,
  count: string,
  author: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(events.length).to.equal(Number(count))
  expect(events[0].kind).to.equal(10000)
  expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)
  expect(events[0].content).to.equal(this.parameters.lowerIdEventContent)
})

