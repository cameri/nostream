import { Then, When, World } from '@cucumber/cucumber'
import chai from 'chai'
import sinonChai from 'sinon-chai'
import { WebSocket } from 'ws'

import {
  createSubscription,
  waitForEOSE,
  waitForEventCount,
} from '../helpers'

chai.use(sinonChai)
const { expect } = chai

When(
  /^(\w+) subscribes to search for "([^"]+)"$/,
  async function (this: World<Record<string, any>>, name: string, searchQuery: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = { name: `test-${Math.random()}`, filters: [{ search: searchQuery }] }
    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
  },
)

When(
  /^(\w+) subscribes to search for "([^"]+)" with kinds (\d+)$/,
  async function (this: World<Record<string, any>>, name: string, searchQuery: string, kind: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = {
      name: `test-${Math.random()}`,
      filters: [{ search: searchQuery, kinds: [Number(kind)] }],
    }
    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
  },
)

Then(
  /^(\w+) receives (\d+) text_note events? from (\w+) with search match and EOSE$/,
  async function (this: World<Record<string, any>>, name: string, count: string, author: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const events = await waitForEventCount(ws, subscription.name, Number(count), true)

    expect(events.length).to.equal(Number(count))
    for (const event of events) {
      expect(event.kind).to.equal(1)
      expect(event.pubkey).to.equal(this.parameters.identities[author].pubkey)
    }
  },
)

Then(
  /^(\w+) receives 0 events for search and EOSE$/,
  async function (this: World<Record<string, any>>, name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]

    await waitForEOSE(ws, subscription.name)
  },
)
