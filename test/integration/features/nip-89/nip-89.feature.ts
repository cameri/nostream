import { Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, createSubscription, sendEvent, waitForNextEvent } from '../helpers'
import { EventKinds } from '../../../../src/constants/base'
import { Event } from '../../../../src/@types/event'

When(
  /^(\w+) sends a handler_information event with content "([^"]*)" and tag (\w) containing "([^"]+)"$/,
  async function (name: string, content: string, tag: string, value: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]

    const event: Event = await createEvent(
      { pubkey, kind: EventKinds.HANDLER_INFORMATION, content, tags: [[tag, value]] },
      privkey,
    )

    await sendEvent(ws, event)
    this.parameters.events[name].push(event)
  },
)

Then(
  /(\w+) receives a handler_information event from (\w+) with content "([^"]*?)" and tag (\w+) containing "([^"]+?)"/,
  async function (name: string, author: string, content: string, tagName: string, tagValue: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const receivedEvent = await waitForNextEvent(ws, subscription.name)

    expect(receivedEvent.kind).to.equal(EventKinds.HANDLER_INFORMATION)
    expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
    expect(receivedEvent.content).to.equal(content)
    expect(receivedEvent.tags[0]).to.deep.equal([tagName, tagValue])
  },
)

When(
  /^(\w+) sends a handler_recommendation event with content "([^"]*)" and tag (\w) containing "([^"]+)"$/,
  async function (name: string, content: string, tag: string, value: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]

    const event: Event = await createEvent(
      { pubkey, kind: EventKinds.HANDLER_RECOMMENDATION, content, tags: [[tag, value]] },
      privkey,
    )

    await sendEvent(ws, event)
    this.parameters.events[name].push(event)
  },
)

Then(
  /(\w+) receives a handler_recommendation event from (\w+) with content "([^"]*?)" and tag (\w+) containing "([^"]+?)"/,
  async function (name: string, author: string, content: string, tagName: string, tagValue: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const receivedEvent = await waitForNextEvent(ws, subscription.name)

    expect(receivedEvent.kind).to.equal(EventKinds.HANDLER_RECOMMENDATION)
    expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
    expect(receivedEvent.content).to.equal(content)
    expect(receivedEvent.tags[0]).to.deep.equal([tagName, tagValue])
  },
)

When(
  /^(\w+) subscribes to handler_information events$/,
  async function (this: World<Record<string, any>>, name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = { name: `test-${Math.random()}`, filters: [{ kinds: [EventKinds.HANDLER_INFORMATION] }] }
    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
  },
)

When(
  /^(\w+) subscribes to handler_recommendation events$/,
  async function (this: World<Record<string, any>>, name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = { name: `test-${Math.random()}`, filters: [{ kinds: [EventKinds.HANDLER_RECOMMENDATION] }] }
    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
  },
)
