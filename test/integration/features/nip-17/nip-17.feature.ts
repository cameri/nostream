import { Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { EventKinds, EventTags } from '../../../../src/constants/base'
import { getConversationKey, nip44Encrypt } from '../../../../src/utils/nip44'
import { createEvent, createSubscription, sendEvent, waitForEventCount } from '../helpers'
import { Event } from '../../../../src/@types/event'
import { CommandResult } from '../../../../src/@types/messages'

const ensureNip17State = (world: World<Record<string, any>>) => {
  world.parameters.nip17 = world.parameters.nip17 ?? {}
  world.parameters.nip17.results = world.parameters.nip17.results ?? {}
}

const storeResult = (world: World<Record<string, any>>, name: string, result: { success: boolean; reason?: string }) => {
  ensureNip17State(world)
  world.parameters.nip17.results[name] = result
}

const sendEventExpectFailure = async (ws: WebSocket, event: Event): Promise<string> => {
  try {
    await sendEvent(ws, event, true)
  } catch (error) {
    return (error as Error).message
  }

  throw new Error('Expected gift wrap publication to fail, but it succeeded')
}

const makeNip44Payload = (senderPrivkey: string, recipientPubkey: string): string => {
  const conversationKey = getConversationKey(senderPrivkey, recipientPubkey)
  return nip44Encrypt('{"kind":13,"content":"sealed"}', conversationKey)
}

When(
  /^(\w+) sends a valid gift_wrap event for (\w+)$/,
  async function (this: World<Record<string, any>>, sender: string, recipient: string) {
    const ws = this.parameters.clients[sender] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[sender]
    const recipientPubkey = this.parameters.identities[recipient].pubkey

    const event: Event = await createEvent(
      {
        pubkey,
        kind: EventKinds.GIFT_WRAP,
        tags: [[EventTags.Pubkey, recipientPubkey]],
        content: makeNip44Payload(privkey, recipientPubkey),
      },
      privkey,
    )

    const command = (await sendEvent(ws, event, true)) as CommandResult

    this.parameters.events[sender].push(event)
    storeResult(this, sender, { success: command[2], reason: command[3] })
  },
)

When(
  /^(\w+) sends an invalid gift_wrap event without a p tag$/,
  async function (this: World<Record<string, any>>, sender: string) {
    const ws = this.parameters.clients[sender] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[sender]

    const event: Event = await createEvent(
      {
        pubkey,
        kind: EventKinds.GIFT_WRAP,
        tags: [],
        content: makeNip44Payload(privkey, pubkey),
      },
      privkey,
    )

    const reason = await sendEventExpectFailure(ws, event)
    storeResult(this, sender, { success: false, reason })
  },
)

When(
  /^(\w+) sends an invalid gift_wrap event with recipients (\w+) and (\w+)$/,
  async function (this: World<Record<string, any>>, sender: string, recipient1: string, recipient2: string) {
    const ws = this.parameters.clients[sender] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[sender]
    const recipientPubkey1 = this.parameters.identities[recipient1].pubkey
    const recipientPubkey2 = this.parameters.identities[recipient2].pubkey

    const event: Event = await createEvent(
      {
        pubkey,
        kind: EventKinds.GIFT_WRAP,
        tags: [
          [EventTags.Pubkey, recipientPubkey1],
          [EventTags.Pubkey, recipientPubkey2],
        ],
        content: makeNip44Payload(privkey, recipientPubkey1),
      },
      privkey,
    )

    const reason = await sendEventExpectFailure(ws, event)
    storeResult(this, sender, { success: false, reason })
  },
)

When(
  /^(\w+) sends an invalid gift_wrap event for (\w+) with malformed NIP-44 payload$/,
  async function (this: World<Record<string, any>>, sender: string, recipient: string) {
    const ws = this.parameters.clients[sender] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[sender]
    const recipientPubkey = this.parameters.identities[recipient].pubkey

    const event: Event = await createEvent(
      {
        pubkey,
        kind: EventKinds.GIFT_WRAP,
        tags: [[EventTags.Pubkey, recipientPubkey]],
        content: 'this is not encrypted',
      },
      privkey,
    )

    const reason = await sendEventExpectFailure(ws, event)
    storeResult(this, sender, { success: false, reason })
  },
)

When(
  /^(\w+) subscribes to gift_wrap events tagged for (\w+)$/,
  async function (this: World<Record<string, any>>, name: string, recipient: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const recipientPubkey = this.parameters.identities[recipient].pubkey
    const subscription = {
      name: `test-${Math.random()}`,
      filters: [{ kinds: [EventKinds.GIFT_WRAP], '#p': [recipientPubkey] }],
    }

    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
  },
)

Then(/^(\w+) receives a successful gift_wrap command result$/, function (this: World<Record<string, any>>, name: string) {
  const result = this.parameters.nip17.results[name] as { success: boolean; reason?: string }

  expect(result.success).to.equal(true)
  expect(result.reason).to.equal('')
})

Then(
  /^(\w+) receives an unsuccessful gift_wrap command result with reason containing "([^"]+)"$/,
  function (this: World<Record<string, any>>, name: string, reasonPart: string) {
    const result = this.parameters.nip17.results[name] as { success: boolean; reason?: string }

    expect(result.success).to.equal(false)
    expect(result.reason).to.contain(reasonPart)
  },
)

Then(
  /^(\w+) receives (\d+) gift_wrap events? from (\w+) tagged for (\w+) and EOSE$/,
  async function (this: World<Record<string, any>>, name: string, count: string, author: string, recipient: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const expectedCount = Number(count)
    const events = await waitForEventCount(ws, subscription.name, expectedCount, true)

    expect(events.length).to.equal(expectedCount)
    expect(events[0].kind).to.equal(EventKinds.GIFT_WRAP)
    expect(events[0].pubkey).to.equal(this.parameters.identities[author].pubkey)

    const recipientPubkey = this.parameters.identities[recipient].pubkey
    const recipientTags = events[0].tags.filter((tag) => tag.length >= 2 && tag[0] === EventTags.Pubkey)

    expect(recipientTags.length).to.equal(1)
    expect(recipientTags[0][1]).to.equal(recipientPubkey)
  },
)
