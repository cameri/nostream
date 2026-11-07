import { Given, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import { ReplaySubject } from 'rxjs'
import WebSocket, { RawData } from 'ws'

import { createEvent, createIdentity, publishEvent } from '../helpers'
import { streams } from '../shared'
import { OutgoingMessage } from '../../../../src/@types/messages'
import { Event } from '../../../../src/@types/event'

const RELAY_URL = 'ws://localhost:18808'
const MESSAGE_TIMEOUT_MS = 10_000
const STEP_TIMEOUT_MS = 120_000

const world = (context: World<Record<string, any>>) => context.parameters as Record<string, any>

type Connection = {
  ws: WebSocket
  messages: ReplaySubject<OutgoingMessage>
  frames: OutgoingMessage[]
}

const eoseIds = (connection: Connection): string[] =>
  connection.frames.filter((message) => message[0] === 'EOSE').map((message) => message[1] as string)

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<void> => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// The listener is attached before 'open' resolves, so a frame written in the
// same turn as the handshake is captured rather than dropped — the whole point
// of these cases, which the shared client steps cannot express.
const createConnection = async (onOpen?: (ws: WebSocket) => void): Promise<Connection> => {
  const ws = new WebSocket(RELAY_URL)
  const messages = new ReplaySubject<OutgoingMessage>(1_000, 60_000)
  const frames: OutgoingMessage[] = []

  ws.on('message', (raw: RawData) => {
    const message = JSON.parse(raw.toString()) as OutgoingMessage
    frames.push(message)
    messages.next(message)
  })

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      onOpen?.(ws)
      resolve()
    })
    ws.once('error', reject)
  })

  streams.set(ws, messages)

  return { ws, messages, frames }
}

const track = (context: World<Record<string, any>>, key: string, connection: Connection): Connection => {
  world(context).clients[key] = connection.ws
  world(context).connections = world(context).connections ?? {}
  world(context).connections[key] = connection

  return connection
}

When(
  /^(\d+) sockets subscribe at the open tick, repeated (\d+) times$/,
  { timeout: STEP_TIMEOUT_MS },
  async function (this: World<Record<string, any>>, sockets: string, rounds: string) {
    const socketCount = Number(sockets)
    const roundCount = Number(rounds)
    const results: { id: string; eose: string[] }[] = []
    world(this).stormExpected = socketCount * roundCount
    world(this).stormResults = results

    for (let round = 0; round < roundCount; round++) {
      const opened = await Promise.all(
        Array.from({ length: socketCount }, (_, index) => {
          const id = `storm-${round}-${index}`
          return createConnection((ws) => ws.send(JSON.stringify(['REQ', id, { kinds: [1] }]))).then((connection) => ({
            id,
            index,
            connection,
          }))
        }),
      )

      for (const { id, index, connection } of opened) {
        track(this, `storm-${round}-${index}`, connection)
        await waitFor(() => eoseIds(connection).includes(id), `EOSE for ${id}`)
        results.push({ id, eose: eoseIds(connection) })
        connection.ws.close()
      }
    }
  },
)

Then(
  'each socket received EOSE for its own subscription',
  { timeout: STEP_TIMEOUT_MS },
  function (this: World<Record<string, any>>) {
    const results = world(this).stormResults as { id: string; eose: string[] }[]

    expect(results).to.have.length(world(this).stormExpected)
    for (const { id, eose } of results) {
      // Exactly one EOSE, carrying that socket's own subscription id.
      expect(eose).to.deep.equal([id])
    }
  },
)

When(
  /^a socket sends REQ "([^"]+)" and then REQ "([^"]+)" in one turn$/,
  { timeout: STEP_TIMEOUT_MS },
  async function (this: World<Record<string, any>>, first: string, second: string) {
    const connection = track(
      this,
      'pipelined',
      await createConnection((ws) => {
        ws.send(JSON.stringify(['REQ', first, { kinds: [1] }]))
        ws.send(JSON.stringify(['REQ', second, { kinds: [1] }]))
      }),
    )

    await waitFor(() => eoseIds(connection).length >= 2, `EOSE for both ${first} and ${second}`)
  },
)

Then(
  /^the socket received EOSE for "([^"]+)" and "([^"]+)"$/,
  { timeout: STEP_TIMEOUT_MS },
  function (this: World<Record<string, any>>, first: string, second: string) {
    // Two REQs are independent handlers, and onClientMessage does not make the
    // second wait for the first, so each EOSE is sent when its own query
    // finishes. Both replies must arrive; their order is not the relay's to
    // promise, and asserting it would fail a correct run.
    expect(eoseIds(world(this).connections.pipelined).sort()).to.deep.equal([first, second].sort())
  },
)

Given(
  /^a publisher called ([\w-]+)$/,
  { timeout: STEP_TIMEOUT_MS },
  function (this: World<Record<string, any>>, name: string) {
    world(this).identities[name] = createIdentity(name)
    world(this).publisher = name
  },
)

When(
  'a socket subscribes at the open tick and closes it in the same turn',
  { timeout: STEP_TIMEOUT_MS },
  async function (this: World<Record<string, any>>) {
    const { pubkey } = world(this).identities[world(this).publisher]

    const connection = track(
      this,
      'cancel',
      await createConnection((ws) => {
        ws.send(JSON.stringify(['REQ', 'race-cancel', { authors: [pubkey], kinds: [1] }]))
        ws.send(JSON.stringify(['CLOSE', 'race-cancel']))
      }),
    )

    // A second subscription on the same socket is the barrier: its EOSE means
    // the CLOSE ahead of it has been handled, without sleeping on the clock.
    connection.ws.send(JSON.stringify(['REQ', 'after-close', { authors: [pubkey], kinds: [1] }]))
    await waitFor(() => eoseIds(connection).includes('after-close'), 'EOSE for after-close')
  },
)

When(
  'the publisher publishes a text note',
  { timeout: STEP_TIMEOUT_MS },
  async function (this: World<Record<string, any>>) {
    const identity = world(this).identities[world(this).publisher]
    const connection = track(this, 'publisher', await createConnection())

    const event = await createEvent(
      { pubkey: identity.pubkey, kind: 1, content: 'race event', tags: [] },
      identity.privkey,
    )
    world(this).publishedEvent = event
    world(this).events[world(this).publisher] = world(this).events[world(this).publisher] ?? []
    world(this).events[world(this).publisher].push(event)

    const result = await publishEvent(connection.ws, event)
    expect(result[2], result[3]).to.equal(true)

    // The live subscription must receive it: the event is broadcast, so its
    // absence from `race-cancel` is a closed subscription, not a missed write.
    const cancel: Connection = world(this).connections.cancel
    await waitFor(
      () => cancel.frames.some((message) => message[0] === 'EVENT' && message[1] === 'after-close'),
      'the event on the live subscription',
    )
  },
)

Then(
  /^"([^"]+)" received no event and the socket still answers$/,
  { timeout: STEP_TIMEOUT_MS },
  function (this: World<Record<string, any>>, subscription: string) {
    const cancel: Connection = world(this).connections.cancel

    expect(cancel.frames.filter((message) => message[0] === 'EVENT' && message[1] === subscription)).to.deep.equal([])
    expect(cancel.frames.filter((message) => message[0] === 'NOTICE')).to.deep.equal([])
    expect(eoseIds(cancel)).to.include('after-close')
    expect(cancel.ws.readyState).to.equal(WebSocket.OPEN)
  },
)

When(
  'the publisher sends an event at the open tick',
  { timeout: STEP_TIMEOUT_MS },
  async function (this: World<Record<string, any>>) {
    const identity = world(this).identities[world(this).publisher]
    const event: Event = await createEvent(
      { pubkey: identity.pubkey, kind: 1, content: 'ok at the open tick', tags: [] },
      identity.privkey,
    )

    world(this).publishedEvent = event
    world(this).events[world(this).publisher] = world(this).events[world(this).publisher] ?? []
    world(this).events[world(this).publisher].push(event)

    const connection = track(this, 'writer', await createConnection((ws) => ws.send(JSON.stringify(['EVENT', event]))))

    await waitFor(
      () => connection.frames.some((message) => message[0] === 'OK' && message[1] === event.id),
      'OK for the event sent at the open tick',
    )
  },
)

Then(
  'the socket received OK for that event',
  { timeout: STEP_TIMEOUT_MS },
  function (this: World<Record<string, any>>) {
    const { publishedEvent } = world(this)
    const ok = (world(this).connections.writer as Connection).frames.find(
      (message) => message[0] === 'OK' && message[1] === publishedEvent.id,
    )

    expect(ok?.[2]).to.equal(true)
  },
)

When(
  'a socket sends a fragmented REQ and a binary REQ in one turn',
  { timeout: STEP_TIMEOUT_MS },
  async function (this: World<Record<string, any>>) {
    const connection = track(
      this,
      'framing',
      await createConnection((ws) => {
        ws.send('["REQ","frag', { fin: false })
        ws.send('-sub",{"kinds":[1]}]', { fin: true })
        ws.send(Buffer.from('["REQ","binary-frame",{"kinds":[1]}]'), { binary: true })
      }),
    )

    await waitFor(() => eoseIds(connection).length >= 2, 'EOSE for the fragmented and the binary REQ')

    connection.ws.send(JSON.stringify(['REQ', 'after-frames', { kinds: [1] }]))
    await waitFor(() => eoseIds(connection).includes('after-frames'), 'EOSE for the next command')
  },
)

Then(
  'both subscriptions received EOSE and the socket still answers',
  { timeout: STEP_TIMEOUT_MS },
  function (this: World<Record<string, any>>) {
    const ids = eoseIds(world(this).connections.framing)

    // The fragmented and the binary REQ are independent handlers, so their
    // replies may arrive in either order. after-frames was sent only after
    // both had answered, so it must come last.
    expect(ids).to.have.length(3)
    expect(ids.slice(2)).to.deep.equal(['after-frames'])
    expect(ids.slice(0, 2).sort()).to.deep.equal(['binary-frame', 'frag-sub'])
  },
)

When(
  'a socket sends invalid JSON and then a REQ',
  { timeout: STEP_TIMEOUT_MS },
  async function (this: World<Record<string, any>>) {
    const connection = track(
      this,
      'invalid',
      await createConnection((ws) => {
        ws.send('{"broken_json_without_closing_bracket')
        ws.send(JSON.stringify(['REQ', 'valid-after-bad', { kinds: [1] }]))
      }),
    )

    await waitFor(
      () => connection.frames.some((message) => message[0] === 'NOTICE') && eoseIds(connection).length >= 1,
      'a NOTICE and an EOSE',
    )
  },
)

Then(
  'the socket received a NOTICE and then EOSE for the REQ',
  { timeout: STEP_TIMEOUT_MS },
  function (this: World<Record<string, any>>) {
    const connection: Connection = world(this).connections.invalid
    const notice = connection.frames.find((message) => message[0] === 'NOTICE')

    expect(notice?.[1]).to.match(/^invalid:/)
    expect(eoseIds(connection)).to.deep.equal(['valid-after-bad'])
    expect(connection.ws.readyState).to.equal(WebSocket.OPEN)
  },
)
