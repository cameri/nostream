import { Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, createSubscription, sendEvent, waitForEOSE, waitForNextEvent } from '../helpers'
import { EventKinds, EventTags } from '../../../../src/constants/base'
import { CommandResult } from '../../../../src/@types/messages'
import { Event } from '../../../../src/@types/event'

When(/^(\w+) sends an encrypted_direct_message event with content "([^"]+)" to (\w+)$/, async function(
  name: string,
  content: string,
  recipient: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]
  const recipientPubkey = this.parameters.identities[recipient].pubkey

  const event: Event = await createEvent(
    {
      pubkey,
      kind: EventKinds.ENCRYPTED_DIRECT_MESSAGE,
      content,
      tags: [[EventTags.Pubkey, recipientPubkey]],
    },
    privkey,
  )

  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(/^(\w+) subscribes to tag p with (\w+) pubkey$/, async function(
  this: World<Record<string, any>>,
  name: string,
  target: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const targetPubkey = this.parameters.identities[target].pubkey
  const subscription = { name: `test-${Math.random()}`, filters: [{ '#p': [targetPubkey] }] }
  this.parameters.subscriptions[name].push(subscription)

  await createSubscription(ws, subscription.name, subscription.filters)
  await waitForEOSE(ws, subscription.name)
})

Then(/(\w+) receives an encrypted_direct_message event from (\w+) with content "([^"]+?)" tagged for (\w+)/, async function(
  name: string,
  author: string,
  content: string,
  recipient: string,
) {
  const ws = this.parameters.clients[name] as WebSocket
  const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
  const recipientPubkey = this.parameters.identities[recipient].pubkey
  const receivedEvent = await waitForNextEvent(ws, subscription.name, content)

  expect(receivedEvent.kind).to.equal(EventKinds.ENCRYPTED_DIRECT_MESSAGE)
  expect(receivedEvent.pubkey).to.equal(this.parameters.identities[author].pubkey)
  expect(receivedEvent.content).to.equal(content)
  expect(receivedEvent.tags).to.deep.include([EventTags.Pubkey, recipientPubkey])
})

When(/^(\w+) resubmits their last event$/, async function(name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const event = this.parameters.events[name][this.parameters.events[name].length - 1] as Event
  const command = await sendEvent(ws, event) as CommandResult
  this.parameters.commands = this.parameters.commands ?? {}
  this.parameters.commands[name] = command
})

Then(/^(\w+) receives a successful command result with message "([^"]+)"$/, function(name: string, message: string) {
  const command = this.parameters.commands[name] as CommandResult

  expect(command[2]).to.equal(true)
  expect(command[3]).to.equal(message)
})
