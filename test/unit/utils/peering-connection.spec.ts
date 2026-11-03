import { expect } from 'chai'
import EventEmitter from 'events'
import { Negentropy, NegentropyStorageVector } from '../../../src/utils/negentropy'
import { PeeringConnection } from '../../../src/utils/peering-connection'

class FakeSocket extends EventEmitter {
  public readonly sent: unknown[][] = []
  private responder?: Negentropy
  private readonly remoteEvents: {
    id: string
    created_at: number
    content: string
    pubkey: string
    kind: number
    tags: string[][]
    sig: string
    [key: string]: unknown
  }[]

  public constructor(
    remoteItems: { timestamp: number; id: Uint8Array }[],
    remoteEvents: FakeSocket['remoteEvents'] = [],
  ) {
    super()
    const storage = new NegentropyStorageVector()
    for (const item of remoteItems) {
      storage.insert(item.timestamp, item.id)
    }
    storage.seal()
    this.responder = new Negentropy(storage)
    this.remoteEvents = remoteEvents
  }

  public send(raw: string): void {
    const message = JSON.parse(raw) as unknown[]
    this.sent.push(message)

    switch (message[0]) {
      case 'NEG-OPEN':
      case 'NEG-MSG': {
        const neg = this.responder as Negentropy
        const { output } = neg.reconcile(Buffer.from((message[3] as string) ?? (message[2] as string), 'hex'))
        if (output) {
          this.deliver(['NEG-MSG', message[1], Buffer.from(output).toString('hex')])
        }
        return
      }
      case 'REQ': {
        const subscriptionId = message[1]
        for (const event of this.remoteEvents) {
          this.deliver(['EVENT', subscriptionId, event])
        }
        this.deliver(['EOSE', subscriptionId])
        return
      }
      case 'CLOSE':
      case 'NEG-CLOSE':
        return
      default:
        return
    }
  }

  public close(): void {
    this.emit('close')
  }

  public deliver(message: unknown[]): void {
    this.emit('message', Buffer.from(JSON.stringify(message)))
  }
}

const id = (byte: number): Uint8Array => Uint8Array.from({ length: 32 }, () => byte)

describe('PeeringConnection', () => {
  it('reconciles ids in both directions over NEG-OPEN/NEG-MSG', async () => {
    const localId = id(1)
    const remoteId = id(2)
    const socket = new FakeSocket([{ timestamp: 10, id: remoteId }])
    const connection = new PeeringConnection(socket as any)

    const result = await connection.reconcile(
      { kinds: [1] },
      [{ event_created_at: 5, event_id: Buffer.from(localId) }],
      1_000,
    )

    expect(result.needIds).to.deep.equal([Buffer.from(remoteId).toString('hex')])
    expect(result.haveIds).to.deep.equal([Buffer.from(localId).toString('hex')])
    expect(socket.sent.some((message) => message[0] === 'NEG-OPEN')).to.equal(true)
    expect(socket.sent.some((message) => message[0] === 'NEG-CLOSE')).to.equal(true)
  })

  it('fetches requested events and resolves on EOSE', async () => {
    const remoteId = id(2)
    const event = {
      id: Buffer.from(remoteId).toString('hex'),
      pubkey: 'f'.repeat(64),
      created_at: 10,
      kind: 1,
      tags: [],
      content: 'hello',
      sig: 'a'.repeat(128),
    }
    const socket = new FakeSocket([], [event])
    const connection = new PeeringConnection(socket as any)

    const events = await connection.fetchEvents([event.id], 1_000)

    expect(events).to.deep.equal([event])
  })

  it('ignores unrequested and duplicate fetch replies', async () => {
    const wanted = {
      id: 'b'.repeat(64),
      pubkey: 'f'.repeat(64),
      created_at: 10,
      kind: 1,
      tags: [],
      content: 'wanted',
      sig: 'a'.repeat(128),
    }
    const extra = { ...wanted, id: 'c'.repeat(64), content: 'extra' }
    const socket = new FakeSocket([], [wanted, wanted, extra])
    const connection = new PeeringConnection(socket as any)

    const events = await connection.fetchEvents([wanted.id], 1_000)

    expect(events).to.deep.equal([wanted])
  })

  it('keeps a live subscription open after EOSE', async () => {
    const socket = new FakeSocket([])
    const connection = new PeeringConnection(socket as any)
    const received: unknown[] = []

    await connection.subscribe([{ kinds: [1] }], (event) => received.push(event), 1_000)

    socket.deliver(['EVENT', socket.sent.find((message) => message[0] === 'REQ')?.[1], { id: 'a'.repeat(64), kind: 1 }])

    expect(received).to.have.length(1)
  })

  it('rejects a fetch that exceeds its byte budget', async () => {
    const event = {
      id: 'b'.repeat(64),
      pubkey: 'f'.repeat(64),
      created_at: 10,
      kind: 1,
      tags: [],
      content: 'x'.repeat(1_000),
      sig: 'a'.repeat(128),
    }
    const socket = new FakeSocket([], [event])
    const connection = new PeeringConnection(socket as any)

    const error = await connection.fetchEvents([event.id], 1_000, 100).then(
      () => undefined,
      (err: Error) => err,
    )

    expect(error?.message).to.equal('peer sent more event data than this request allows')
  })

  it('rejects when the peer returns NEG-ERR', async () => {
    const socket = new FakeSocket([])
    const connection = new PeeringConnection(socket as any)
    socket.send = function (raw: string): void {
      const message = JSON.parse(raw) as unknown[]
      this.deliver(['NEG-ERR', message[1], 'blocked: too big'])
    }

    const error = await connection.reconcile({ kinds: [1] }, [], 1_000).then(
      () => undefined,
      (err: Error) => err,
    )

    expect(error?.message).to.equal('blocked: too big')
  })
})
