import { Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'
import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { createEvent, createSubscription, sendEvent, waitForEventCount, waitForNextEvent } from '../helpers'

When(/^(\w+) sends a relay_list event with relays "([^"]+)"$/, async function (name: string, relayUrl: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent(
    {
      pubkey,
      kind: EventKinds.RELAY_LIST,
      content: '',
      tags: [['r', relayUrl]],
    },
    privkey,
  )

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(
  /^(\w+) sends a relay_list event with a read relay "([^"]+)" and a write relay "([^"]+)"$/,
  async function (name: string, readRelay: string, writeRelay: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]

    const event: Event = await createEvent(
      {
        pubkey,
        kind: EventKinds.RELAY_LIST,
        content: '',
        tags: [
          ['r', readRelay, 'read'],
          ['r', writeRelay, 'write'],
        ],
      },
      privkey,
    )

    await sendEvent(ws, event)
    this.parameters.events[name].push(event)
  },
)

When(
  /^(\w+) subscribes to (?:her|his|their) relay_list events$/,
  async function (this: World<Record<string, any>>, name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey } = this.parameters.identities[name]
    const subscription = {
      name: `test-${Math.random()}`,
      filters: [{ kinds: [EventKinds.RELAY_LIST], authors: [pubkey] }],
    }
    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
  },
)

Then(/^(\w+) receives a relay_list event with relays "([^"]+)"$/, async function (name: string, relayUrl: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const receivedEvent = await waitForNextEvent(ws, subscription.name)

  expect(receivedEvent.kind).to.equal(EventKinds.RELAY_LIST)
  expect(receivedEvent.tags).to.deep.include(['r', relayUrl])
})

Then(
  /^(\w+) receives a relay_list event with a read relay "([^"]+)" and a write relay "([^"]+)"$/,
  async function (name: string, readRelay: string, writeRelay: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const receivedEvent = await waitForNextEvent(ws, subscription.name)

    expect(receivedEvent.kind).to.equal(EventKinds.RELAY_LIST)
    expect(receivedEvent.tags).to.deep.include(['r', readRelay, 'read'])
    expect(receivedEvent.tags).to.deep.include(['r', writeRelay, 'write'])
  },
)

Then(/^(\w+) receives (\d+) relay_list event(?:s)? and EOSE$/, async function (name: string, count: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(events.length).to.equal(Number(count))
  expect(events[0].kind).to.equal(EventKinds.RELAY_LIST)

  this.parameters.lastRelayListEvents = events
})

Then(
  /^the relay_list event has relays "([^"]+)"$/,
  async function (this: World<Record<string, any>>, relayUrl: string) {
    const events: Event[] = this.parameters.lastRelayListEvents
    expect(events[0].tags).to.deep.include(['r', relayUrl])
  },
)
