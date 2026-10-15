import { Then, When, World } from '@cucumber/cucumber'
import chai from 'chai'
import { Observable } from 'rxjs'
import { WebSocket } from 'ws'

import { MessageType, OutgoingMessage } from '../../../../src/@types/messages'
import { SubscriptionFilter } from '../../../../src/@types/subscription'
import { streams } from '../shared'

const { expect } = chai

function sendCount(world: World<Record<string, any>>, name: string, filters: SubscriptionFilter[]): void {
  const ws = world.parameters.clients[name] as WebSocket
  const queryId = `count-${Math.random()}`

  world.parameters.counts = world.parameters.counts ?? {}
  world.parameters.counts[name] = new Promise<number>((resolve, reject) => {
    const observable = streams.get(ws) as Observable<OutgoingMessage>

    const subscription = observable.subscribe((message: OutgoingMessage) => {
      if (message[1] !== queryId) {
        return
      }

      subscription.unsubscribe()
      if (message[0] === MessageType.COUNT) {
        resolve(message[2].count)
      } else {
        reject(new Error(`COUNT ${queryId} was not answered with a count: ${JSON.stringify(message)}`))
      }
    })
  })

  ws.send(JSON.stringify(['COUNT', queryId, ...filters]))
}

When(
  /^(\w+) counts text_note events from (\w+)$/,
  function (this: World<Record<string, any>>, name: string, author: string) {
    sendCount(this, name, [{ kinds: [1], authors: [this.parameters.identities[author].pubkey] }])
  },
)

When(
  /^(\w+) counts events from (\w+) with tag (\w) "([^"]+)" and tag (\w) "([^"]+)"$/,
  function (
    this: World<Record<string, any>>,
    name: string,
    author: string,
    tag1: string,
    value1: string,
    tag2: string,
    value2: string,
  ) {
    sendCount(this, name, [
      { authors: [this.parameters.identities[author].pubkey], [`#${tag1}`]: [value1], [`#${tag2}`]: [value2] },
    ])
  },
)

When(
  /^(\w+) counts the last event from (\w+) with tag (\w) "([^"]+)"$/,
  function (this: World<Record<string, any>>, name: string, author: string, tag: string, value: string) {
    const event = this.parameters.events[author][this.parameters.events[author].length - 1]
    sendCount(this, name, [{ ids: [event.id], [`#${tag}`]: [value] }])
  },
)

When(
  /^(\w+) counts text_note events from (\w+) with a limit of (\d+) or set_metadata events from (\w+)$/,
  function (this: World<Record<string, any>>, name: string, author1: string, limit: string, author2: string) {
    sendCount(this, name, [
      { kinds: [1], authors: [this.parameters.identities[author1].pubkey], limit: Number(limit) },
      { kinds: [0], authors: [this.parameters.identities[author2].pubkey] },
    ])
  },
)

Then(
  /^(\w+) receives a count of (\d+)$/,
  async function (this: World<Record<string, any>>, name: string, count: string) {
    expect(await this.parameters.counts[name]).to.equal(Number(count))
  },
)
