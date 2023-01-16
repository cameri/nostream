import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, sendEvent, waitForEventCount } from '../helpers'
import { Event } from '../../../../src/@types/event'
import { EventTags } from '../../../../src/constants/base'
import { isDraft } from '../shared'
import { Tag } from '../../../../src/@types/base'

When(/^(\w+) sends a delete event for their last event$/, async function(
  name: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const tags: Tag[] = [
    [EventTags.Event, this.parameters.events[name][this.parameters.events[name].length - 1].id],
  ]

  const event: Event = await createEvent({ pubkey, kind: 5, content: '', tags }, privkey)

  await sendEvent(ws, event)

  this.parameters.events[name].push(event)
})

Then(
  /(\w+) receives (\d+) delete events? from (\w+) and EOSE$/,
  async function(name: string, count: string, author: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const [event] = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(event.kind).to.equal(5)
  expect(event.pubkey).to.equal(this.parameters.identities[author].pubkey)
})

Then(
  /(\w+) receives (\d+) delete events? from (\w+)$/,
  async function(name: string, count: string, author: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const [event] = await waitForEventCount(ws, subscription.name, Number(count), false)

  expect(event.kind).to.equal(5)
  expect(event.pubkey).to.equal(this.parameters.identities[author].pubkey)
})

When(/^(\w+) drafts a text_note event with content "([^"]+)"$/, async function(name: string, content: string) {
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 1, content }, privkey)

  event[isDraft] = true

  this.parameters.events[name].push(event)
})

Given(/^(\w+) drafts a set_metadata event$/, async function(name: string) {
  const { pubkey, privkey } = this.parameters.identities[name]

  const content = JSON.stringify({ name })
  const event: Event = await createEvent({ pubkey, kind: 0, content }, privkey)

  event[isDraft] = true

  this.parameters.events[name].push(event)
})
