import { Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'
import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { createEvent, createSubscription, sendEvent, waitForNextEvent } from '../helpers'

When(/^(\w+) reacts to (\w+)'s note with "([^"]+)"$/, async function (reactor: string, author: string, content: string) {
    const ws = this.parameters.clients[reactor] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[reactor]
    const targetEvent = this.parameters.events[author][this.parameters.events[author].length - 1] as Event

    const event: Event = await createEvent(
        {
            pubkey,
            kind: EventKinds.REACTION,
            content,
            tags: [
                ['e', targetEvent.id],
                ['p', targetEvent.pubkey],
            ],
        },
        privkey,
    )

    await sendEvent(ws, event)
    this.parameters.events[reactor].push(event)
})

When(/^(\w+) subscribes to (?:her|his|their) reaction events$/, async function (this: World<Record<string, any>>, name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey } = this.parameters.identities[name]
    const subscription = {
        name: `test-${Math.random()}`,
        filters: [{ kinds: [EventKinds.REACTION], authors: [pubkey] }],
    }
    this.parameters.subscriptions[name].push(subscription)

    await createSubscription(ws, subscription.name, subscription.filters)
})

Then(/^(\w+) receives a reaction event with content "([^"]+)"$/, async function (name: string, content: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const subscription = this.parameters.subscriptions[name][this.parameters.subscriptions[name].length - 1]
    const receivedEvent = await waitForNextEvent(ws, subscription.name)

    expect(receivedEvent.kind).to.equal(EventKinds.REACTION)
    expect(receivedEvent.content).to.equal(content)
})