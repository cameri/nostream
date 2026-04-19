import { Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, sendEvent, waitForEventCount } from '../helpers'
import { ALL_RELAYS, EventKinds, EventTags } from '../../../../src/constants/base'
import { Event } from '../../../../src/@types/event'
import { isDraft } from '../shared'

When(/^(\w+) sends a request_to_vanish event$/, async function (name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent(
    { pubkey, kind: EventKinds.REQUEST_TO_VANISH, content: '', tags: [[EventTags.Relay, ALL_RELAYS]] },
    privkey,
  )

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

Then(
  /(\w+) receives (\d+) request_to_vanish events? from (\w+) and EOSE$/,
  async function (name: string, count: string, author: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const events = await waitForEventCount(ws, subscription.name, Number(count), true)

    expect(events.length).to.equal(Number(count))
    expect(events[0].kind).to.equal(EventKinds.REQUEST_TO_VANISH)
    expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)
  },
)

Then(
  /^(\w+) sends their last draft event unsuccessfully because "([^"]+)"$/,
  async function (name: string, reason: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const event = this.parameters.events[name].findLast((event: Event) => event[isDraft])

    delete event[isDraft]

    const command = await sendEvent(ws, event, false)
    expect(command[1]).to.equal(event.id)
    expect(command[2]).to.be.false
    expect(command[3]).to.equal(reason)
  },
)
