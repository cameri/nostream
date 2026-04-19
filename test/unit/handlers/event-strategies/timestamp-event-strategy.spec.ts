import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { DatabaseClient } from '../../../../src/@types/base'
import { Event } from '../../../../src/@types/event'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { MessageType } from '../../../../src/@types/messages'
import { IEventRepository } from '../../../../src/@types/repositories'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'
import { EventKinds } from '../../../../src/constants/base'
import { TimestampEventStrategy } from '../../../../src/handlers/event-strategies/timestamp-event-strategy'
import { EventRepository } from '../../../../src/repositories/event-repository'

const { expect } = chai

// ---------------------------------------------------------------------------
// Minimal `.ots` builder so we don't need the `ots` CLI to make the strategy
// happy. See test/unit/utils/nip03.spec.ts for full parser coverage.
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72,
  0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
])
const BITCOIN_TAG = Buffer.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01])

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

function bitcoinAttestation(height: number): Buffer {
  const payload = writeVarUint(height)
  const lenPrefixed = Buffer.concat([writeVarUint(payload.length), payload])
  return Buffer.concat([Buffer.from([0x00]), BITCOIN_TAG, lenPrefixed])
}

function buildValidOtsForDigest(digestHex: string, blockHeight = 810391): string {
  const digest = Buffer.from(digestHex, 'hex')
  const bytes = Buffer.concat([MAGIC, writeVarUint(1), Buffer.from([0x08]), digest, bitcoinAttestation(blockHeight)])
  return bytes.toString('base64')
}

describe('TimestampEventStrategy', () => {
  const targetEventId = 'e71c6ea722987debdb60f81f9ea4f604b5ac0664120dd64fb9d23abc4ec7c323'

  let event: Event
  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository
  let webSocketEmitStub: Sinon.SinonStub
  let eventRepositoryCreateStub: Sinon.SinonStub
  let strategy: IEventStrategy<Event, Promise<void>>
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    eventRepositoryCreateStub = sandbox.stub(EventRepository.prototype, 'create')

    webSocketEmitStub = sandbox.stub()
    webSocket = { emit: webSocketEmitStub } as any

    const masterClient: DatabaseClient = {} as any
    const readReplicaClient: DatabaseClient = {} as any
    eventRepository = new EventRepository(masterClient, readReplicaClient)

    event = {
      id: 'timestamp-event-id',
      pubkey: 'a'.repeat(64),
      created_at: 1700000000,
      kind: EventKinds.OPEN_TIMESTAMPS,
      tags: [
        ['e', targetEventId, 'wss://relay.example.com'],
        ['k', '1'],
      ],
      content: buildValidOtsForDigest(targetEventId),
      sig: 'c'.repeat(128),
    } as any

    strategy = new TimestampEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('valid opentimestamps event', () => {
    it('stores and broadcasts the event', async () => {
      eventRepositoryCreateStub.resolves(1)

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).to.have.been.calledTwice
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        true,
        '',
      ])
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Broadcast, event)
    })

    it('emits a duplicate OK without broadcasting when the event already exists', async () => {
      eventRepositoryCreateStub.resolves(0)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        true,
        'duplicate:',
      ])
    })

    it('accepts an event without a k tag', async () => {
      event.tags = [['e', targetEventId]]
      eventRepositoryCreateStub.resolves(1)

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnce
    })
  })

  describe('invalid opentimestamps event', () => {
    it('rejects when the e tag is missing', async () => {
      event.tags = []

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*e tag/),
      ])
    })

    it('rejects when multiple e tags are present', async () => {
      event.tags = [
        ['e', targetEventId],
        ['e', 'b'.repeat(64)],
      ]

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*exactly one event/),
      ])
    })

    it('rejects when the e tag value is not a 32-byte hex id', async () => {
      event.tags = [['e', 'not-a-hex-id']]

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*hex event id/),
      ])
    })

    it('rejects upper-case hex in the e tag (NIP-01 requires lowercase)', async () => {
      event.tags = [['e', targetEventId.toUpperCase()]]

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*hex event id/),
      ])
    })

    it('rejects a non-integer k tag', async () => {
      event.tags = [
        ['e', targetEventId],
        ['k', 'banana'],
      ]

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*k tag/),
      ])
    })

    it('rejects a negative k tag', async () => {
      event.tags = [
        ['e', targetEventId],
        ['k', '-1'],
      ]

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*k tag/),
      ])
    })

    it('rejects when multiple k tags are present', async () => {
      event.tags = [
        ['e', targetEventId],
        ['k', '1'],
        ['k', '2'],
      ]

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*at most one k tag/),
      ])
    })

    it('rejects when the OTS digest does not match the e-tagged event id', async () => {
      event.content = buildValidOtsForDigest('d'.repeat(64))

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*digest does not match/),
      ])
    })

    it('rejects when the content is not a valid OTS proof', async () => {
      event.content = Buffer.from('not an ots proof').toString('base64')

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:.*ots proof/),
      ])
    })

    it('rejects when the content is empty', async () => {
      event.content = ''

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).not.to.have.been.called
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        event.id,
        false,
        Sinon.match(/invalid:/),
      ])
    })
  })
})
