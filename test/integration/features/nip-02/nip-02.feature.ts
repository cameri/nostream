import { Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, sendEvent, waitForEventCount, waitForNextEvent } from '../helpers'
import { Event } from '../../../../src/@types/event'
import { EventKinds, EventTags } from '../../../../src/constants/base'

When(
  /^(\w+) sends a contact_list event with tags$/,
  async function (name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]
    
    // Create a simple contact list with a few pubkeys
    const contactPubkey1 = 'a'.repeat(64)
    const contactPubkey2 = 'b'.repeat(64)
    
    const event: Event = await createEvent(
      {
        pubkey,
        kind: EventKinds.CONTACT_LIST,
        tags: [
          [EventTags.Pubkey, contactPubkey1],
          [EventTags.Pubkey, contactPubkey2],
        ],
        content: '',
      },
      privkey,
    )

    await sendEvent(ws, event)
    this.parameters.events[name].push(event)
    this.parameters.contactListEvent = event
  },
)

When(
  /^(\w+) sends a second contact_list event with different tags$/,
  async function (name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]
    
    // Create an updated contact list with different pubkeys
    const contactPubkey3 = 'c'.repeat(64)
    const contactPubkey4 = 'd'.repeat(64)
    
    const event: Event = await createEvent(
      {
        pubkey,
        kind: EventKinds.CONTACT_LIST,
        tags: [
          [EventTags.Pubkey, contactPubkey3],
          [EventTags.Pubkey, contactPubkey4],
        ],
        content: '',
      },
      privkey,
    )

    await sendEvent(ws, event)
    this.parameters.events[name].push(event)
    this.parameters.updatedContactListEvent = event
  },
)

Then(
  /^(\w+) receives a contact_list event from (\w+)$/,
  async function (name: string, author: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const receivedEvent = await waitForNextEvent(ws, subscription.name)

    expect(receivedEvent.kind).to.equal(EventKinds.CONTACT_LIST)
    expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
  },
)

Then(
  /^(\w+) receives 1 contact_list event from (\w+) with the latest tags and EOSE$/,
  async function (name: string, author: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const events = await waitForEventCount(ws, subscription.name, 1, true)

    expect(events.length).to.equal(1)
    expect(events[0].kind).to.equal(EventKinds.CONTACT_LIST)
    expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)
    
    // Verify it's the updated event (has the different contact pubkeys)
    expect(events[0].tags).to.deep.equal(this.parameters.updatedContactListEvent.tags)
  },
)

When(
  /^(\w+) sends two identically-timestamped contact_list events where the second has a lower ID$/,
  async function (name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]

    const commonTimestamp = Math.floor(Date.now() / 1000)
    
    const contactPubkey1 = 'e'.repeat(64)
    const event1 = await createEvent(
      {
        pubkey,
        kind: EventKinds.CONTACT_LIST,
        tags: [[EventTags.Pubkey, contactPubkey1]],
        content: 'first contact list',
        created_at: commonTimestamp,
      },
      privkey,
    )

    let nonce = 0
    let event2: Event
    const contactPubkey2 = 'f'.repeat(64)
    for (;;) {
      event2 = await createEvent(
        {
          pubkey,
          kind: EventKinds.CONTACT_LIST,
          tags: [[EventTags.Pubkey, contactPubkey2]],
          content: `second contact list ${nonce++}`,
          created_at: commonTimestamp,
        },
        privkey,
      )

      if (event2.id < event1.id) {
        break
      }
    }

    await sendEvent(ws, event1)
    await sendEvent(ws, event2)

    this.parameters.events[name].push(event1, event2)
    this.parameters.lowerIdContactListContent = event2.tags
  },
)

Then(
  /^(\w+) receives 1 contact_list event from (\w+) matching the lower ID event and EOSE$/,
  async function (name: string, author: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const events = await waitForEventCount(ws, subscription.name, 1, true)

    expect(events.length).to.equal(1)
    expect(events[0].kind).to.equal(EventKinds.CONTACT_LIST)
    expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)
    expect(events[0].tags).to.deep.equal(this.parameters.lowerIdContactListContent)
  },
)
