import { Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, createSubscription, publishEvent, waitForEventCount } from '../helpers'
import { ExpiringEvent } from '../../../../src/@types/event'
import { EventExpirationTimeMetadataKey, EventKinds, EventTags } from '../../../../src/constants/base'
import { getMasterDbClient } from '../../../../src/database/client'
import { EventRepository } from '../../../../src/repositories/event-repository'

const now = (): number => Math.floor(Date.now() / 1000)

const createTextNoteWithExpiration = async (
  world: World<Record<string, any>>,
  name: string,
  content: string,
  expirationTime: number,
): Promise<ExpiringEvent> => {
  const ws = world.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = world.parameters.identities[name]

  const event = await createEvent(
    {
      pubkey,
      kind: EventKinds.TEXT_NOTE,
      content,
      tags: [[EventTags.Expiration, expirationTime.toString()]],
    },
    privkey,
  ) as ExpiringEvent

  event[EventExpirationTimeMetadataKey] = expirationTime

  await publishEvent(ws, event)

  world.parameters.events[name].push(event)

  return event
}

const seedStoredTextNoteWithExpiration = async (
  world: World<Record<string, any>>,
  name: string,
  content: string,
  expirationTime: number,
): Promise<ExpiringEvent> => {
  const { pubkey, privkey } = world.parameters.identities[name]
  const dbClient = getMasterDbClient()
  const repository = new EventRepository(dbClient, dbClient)

  const event = await createEvent(
    {
      pubkey,
      kind: EventKinds.TEXT_NOTE,
      created_at: expirationTime - 30,
      content,
      tags: [[EventTags.Expiration, expirationTime.toString()]],
    },
    privkey,
  ) as ExpiringEvent

  event[EventExpirationTimeMetadataKey] = expirationTime

  const inserted = await repository.create(event)
  expect(inserted).to.equal(1)

  world.parameters.events[name].push(event)

  return event
}

When(/^(\w+) sends a text_note event with content "([^"]+)" and expiration in the past$/, async function(
  this: World<Record<string, any>>,
  name: string,
  content: string,
) {
  await createTextNoteWithExpiration(this, name, content, now() - 10)
})

When(/^(\w+) sends a text_note event with content "([^"]+)" and expiration in the future$/, async function(
  this: World<Record<string, any>>,
  name: string,
  content: string,
) {
  await createTextNoteWithExpiration(this, name, content, now() + 30)
})

When(/^(\w+) has a stored text_note event with content "([^"]+)" and expiration in the past$/, async function(
  this: World<Record<string, any>>,
  name: string,
  content: string,
) {
  await seedStoredTextNoteWithExpiration(this, name, content, now() - 10)
})

When(/^(\w+) sends a text_note event with content "([^"]+)" and expiration in (\d+) seconds$/, async function(
  this: World<Record<string, any>>,
  name: string,
  content: string,
  durationSeconds: string,
) {
  const expirationTime = now() + Number(durationSeconds)
  const event = await createTextNoteWithExpiration(this, name, content, expirationTime)
  const expirationTag = event.tags.find((tag) => tag[0] === EventTags.Expiration)

  expect(expirationTag).to.not.equal(undefined)
  expect(Number(expirationTag?.[1])).to.equal(expirationTime)
})

When(/^(\w+) subscribes to text_note events from (\w+)$/, async function(
  this: World<Record<string, any>>,
  name: string,
  author: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const authorPubkey = this.parameters.identities[author].pubkey
  const subscription = {
    name: `test-${Math.random()}`,
    filters: [{ kinds: [EventKinds.TEXT_NOTE], authors: [authorPubkey] }],
  }

  this.parameters.subscriptions[name].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
})

Then(/^(\w+) receives (\d+) text_note events and EOSE$/, async function(
  this: World<Record<string, any>>,
  name: string,
  count: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const events = await waitForEventCount(ws, subscription.name, Number(count), true)

  expect(events.length).to.equal(Number(count))

  events.forEach((event) => {
    expect(event.kind).to.equal(EventKinds.TEXT_NOTE)
  })
})
