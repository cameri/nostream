import { Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import WebSocket from 'ws'

import { createEvent, createSubscription, sendEvent, waitForNextEvent } from '../helpers'
import { Event } from '../../../../src/@types/event'
import { Tag } from '../../../../src/@types/base'
import { EventKinds, EventTags } from '../../../../src/constants/base'

// Minimal OpenTimestamps v1 proof (SHA-256 file hash + Bitcoin block attestation), aligned with
// `test/unit/utils/nip03.spec.ts` — exercises the same parser path the relay accepts in production.

const MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
])

const BITCOIN_TAG = Buffer.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01])
const OP_SHA256 = 0x08
const TAG_ATTESTATION = 0x00

function writeVarUint(n: number): Buffer {
  if (n === 0) {
    return Buffer.from([0])
  }
  const out: number[] = []
  let v = n
  while (v !== 0) {
    let b = v & 0x7f
    v = Math.floor(v / 128)
    if (v !== 0) {
      b |= 0x80
    }
    out.push(b)
  }
  return Buffer.from(out)
}

function writeVarBytes(buf: Buffer): Buffer {
  return Buffer.concat([writeVarUint(buf.length), buf])
}

function bitcoinAttestation(height: number): Buffer {
  const payload = writeVarUint(height)
  return Buffer.concat([Buffer.from([TAG_ATTESTATION]), BITCOIN_TAG, writeVarBytes(payload)])
}

/** Base64-encoded .ots whose SHA-256 file digest equals `digestHex` (the attested event id). */
function buildMinimalOtsBase64(digestHex: string, blockHeight = 810391): string {
  const digest = Buffer.from(digestHex, 'hex')
  return Buffer.concat([
    MAGIC,
    writeVarUint(1),
    Buffer.from([OP_SHA256]),
    digest,
    bitcoinAttestation(blockHeight),
  ]).toString('base64')
}

function lastTextNoteFor(events: Event[] | undefined): Event | undefined {
  if (!events?.length) {
    return undefined
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 1) {
      return events[i]
    }
  }
  return undefined
}

When(/^(\w+) sends a valid OpenTimestamps attestation for her last text_note event$/, async function (name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]
  const note = lastTextNoteFor(this.parameters.events[name] as Event[])
  expect(note, 'last text_note').to.exist

  const content = buildMinimalOtsBase64(note!.id)
  const tags: Tag[] = [
    [EventTags.Event, note!.id, 'wss://localhost:18808'],
    [EventTags.Kind, String(1)],
  ]
  const event: Event = await createEvent({ pubkey, kind: EventKinds.OPEN_TIMESTAMPS, content, tags }, privkey)
  await sendEvent(ws, event)
  this.parameters.events[name].push(event)
})

When(
  /^(\w+) sends an OpenTimestamps attestation with mismatching OTS digest for her last text_note event$/,
  async function (name: string) {
    const ws = this.parameters.clients[name] as WebSocket
    const { pubkey, privkey } = this.parameters.identities[name]
    const note = lastTextNoteFor(this.parameters.events[name] as Event[])
    expect(note, 'last text_note').to.exist

    const content = buildMinimalOtsBase64('0'.repeat(64))
    const tags: Tag[] = [
      [EventTags.Event, note!.id, 'wss://localhost:18808'],
      [EventTags.Kind, String(1)],
    ]
    const event: Event = await createEvent({ pubkey, kind: EventKinds.OPEN_TIMESTAMPS, content, tags }, privkey)
    await sendEvent(ws, event, false)
  },
)

When(/^(\w+) subscribes to OpenTimestamps events from (\w+)$/, async function (name: string, author: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const pubkey = this.parameters.identities[author].pubkey
  const subscription = {
    name: `test-${Math.random()}`,
    filters: [{ kinds: [EventKinds.OPEN_TIMESTAMPS], authors: [pubkey] }],
  }
  this.parameters.subscriptions[name].push(subscription)
  await createSubscription(ws, subscription.name, subscription.filters)
})

Then(
  /^(\w+) receives an OpenTimestamps attestation from (\w+) for her last text_note event$/,
  async function (recipient: string, author: string) {
    const ws = this.parameters.clients[recipient] as WebSocket
    const subscription = this.parameters.subscriptions[recipient][this.parameters.subscriptions[recipient].length - 1]
    const received = (await waitForNextEvent(ws, subscription.name)) as Event
    const note = lastTextNoteFor(this.parameters.events[author] as Event[])

    expect(received.kind).to.equal(EventKinds.OPEN_TIMESTAMPS)
    expect(received.pubkey).to.equal(this.parameters.identities[author].pubkey)
    const eTags = received.tags.filter((t) => t[0] === EventTags.Event && t.length >= 2)
    expect(eTags.length).to.equal(1)
    expect(eTags[0][1]).to.equal(note?.id)
    const kTag = received.tags.find((t) => t[0] === EventTags.Kind)
    expect(kTag?.[1]).to.equal('1')
  },
)
