import * as secp256k1 from '@noble/secp256k1'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { getConversationKey, nip44Encrypt } from '../../../../src/utils/nip44'
import { DatabaseClient } from '../../../../src/@types/base'
import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { GiftWrapEventStrategy } from '../../../../src/handlers/event-strategies/gift-wrap-event-strategy'
import { IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

const { expect } = chai

// Generate a valid NIP-44 v2 payload for use as gift wrap content
function makeValidPayload(): string {
  const sec1 = '0000000000000000000000000000000000000000000000000000000000000001'
  const sec2 = '0000000000000000000000000000000000000000000000000000000000000002'
  const pub2 = Buffer.from(secp256k1.getPublicKey(sec2, true)).subarray(1).toString('hex')
  const convKey = getConversationKey(sec1, pub2)
  return nip44Encrypt('{"kind":13,"content":"sealed"}', convKey)
}

describe('GiftWrapEventStrategy', () => {
  const recipientPubkey = 'a'.repeat(64)

  let validPayload: string
  let event: Event
  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository
  let webSocketEmitStub: Sinon.SinonStub
  let eventRepositoryCreateStub: Sinon.SinonStub
  let strategy: IEventStrategy<Event, Promise<void>>
  let sandbox: Sinon.SinonSandbox

  before(() => {
    validPayload = makeValidPayload()
  })

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    eventRepositoryCreateStub = sandbox.stub(EventRepository.prototype, 'create')

    webSocketEmitStub = sandbox.stub()
    webSocket = { emit: webSocketEmitStub } as any

    const masterClient: DatabaseClient = {} as any
    const readReplicaClient: DatabaseClient = {} as any
    eventRepository = new EventRepository(masterClient, readReplicaClient)

    event = {
      id: 'gift-wrap-id',
      pubkey: 'b'.repeat(64), // ephemeral key — random per NIP-17
      created_at: 1700000000,
      kind: EventKinds.GIFT_WRAP,
      tags: [['p', recipientPubkey]],
      content: validPayload,
      sig: 'c'.repeat(128),
    } as any

    strategy = new GiftWrapEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    describe('valid gift wrap', () => {
      it('creates the event in the repository', async () => {
        eventRepositoryCreateStub.resolves(1)

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      })

      it('sends OK and broadcasts when the event is new', async () => {
        eventRepositoryCreateStub.resolves(1)

        await strategy.execute(event)

        expect(webSocketEmitStub).to.have.been.calledTwice
        expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          true,
          '',
        ])
        expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Broadcast, event)
      })

      it('sends OK with duplicate marker and does not broadcast when event already exists', async () => {
        eventRepositoryCreateStub.resolves(0)

        await strategy.execute(event)

        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          true,
          'duplicate:',
        ])
      })
    })

    describe('invalid gift wrap — p tag', () => {
      it('rejects when the p tag is missing', async () => {
        event.tags = []

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*p tag/),
        ])
      })

      it('rejects when there are multiple p tags', async () => {
        event.tags = [
          ['p', 'a'.repeat(64)],
          ['p', 'b'.repeat(64)],
        ]

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*exactly one p tag/),
        ])
      })

      it('accepts p tag with an optional relay hint', async () => {
        event.tags = [['p', recipientPubkey, 'wss://inbox.example.com']]
        eventRepositoryCreateStub.resolves(1)

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).to.have.been.calledOnce
        expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          true,
          '',
        ])
      })
    })

    describe('invalid gift wrap — content format', () => {
      it('rejects when content is empty', async () => {
        event.content = ''

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*NIP-44/),
        ])
      })

      it('rejects when content is plain text instead of a NIP-44 payload', async () => {
        event.content = 'this is not encrypted'

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*NIP-44/),
        ])
      })

      it('rejects when content signals an unsupported version (#)', async () => {
        event.content = '#future-version-payload'

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*NIP-44/),
        ])
      })
    })
  })
})
