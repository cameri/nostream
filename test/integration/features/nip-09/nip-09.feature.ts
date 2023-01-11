import { Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, sendEvent, waitForEventCount } from '../helpers'
import { Event } from '../../../../src/@types/event'
import { EventTags } from '../../../../src/constants/base'
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

  console.log('event', event)

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

Then(
  /(\w+) receives (\d+) delete events? from (\w+) and EOSE/,
  async function(name: string, count: string, author: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const [event] = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(event.kind).to.equal(5)
  expect(event.pubkey).to.equal(this.parameters.identities[author].pubkey)
})