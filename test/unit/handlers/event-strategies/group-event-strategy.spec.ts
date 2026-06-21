import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

import { DatabaseClient } from '../../../../src/@types/base'
import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { GroupEventStrategy } from '../../../../src/handlers/event-strategies/group-event-strategy'
import { IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

const { expect } = chai

const VALID_GROUP_ID = 'a'.repeat(64)

describe('GroupEventStrategy', () => {
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
      id: 'group-event-id',
      pubkey: 'b'.repeat(64), // ephemeral per MIP-03
      created_at: 1700000000,
      kind: EventKinds.MARMOT_GROUP_EVENT,
      tags: [['h', VALID_GROUP_ID]],
      content: 'base64encodedencryptedcontent',
      sig: 'c'.repeat(128),
    } as any

    strategy = new GroupEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    describe('valid group event', () => {
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

      it('accepts an optional expiration tag alongside the h tag', async () => {
        event.tags = [['h', VALID_GROUP_ID], ['expiration', '9999999999']]
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

    describe('invalid group event — h tag missing', () => {
      it('rejects when the h tag is absent', async () => {
        event.tags = []

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*h tag/),
        ])
      })

      it('rejects when the only tag is not an h tag', async () => {
        event.tags = [['p', 'a'.repeat(64)]]

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*h tag/),
        ])
      })
    })

    describe('invalid group event — multiple h tags', () => {
      it('rejects when there are two h tags', async () => {
        event.tags = [
          ['h', VALID_GROUP_ID],
          ['h', 'b'.repeat(64)],
        ]

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*exactly one h tag/),
        ])
      })
    })

    describe('invalid group event — h tag value format', () => {
      it('rejects when the group id is too short', async () => {
        event.tags = [['h', 'a'.repeat(63)]]

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*64-character/),
        ])
      })

      it('rejects when the group id is too long', async () => {
        event.tags = [['h', 'a'.repeat(65)]]

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*64-character/),
        ])
      })

      it('rejects when the group id contains uppercase hex chars', async () => {
        event.tags = [['h', 'A'.repeat(64)]]

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*64-character/),
        ])
      })

      it('rejects when the group id contains non-hex characters', async () => {
        event.tags = [['h', 'g'.repeat(64)]]

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).not.to.have.been.called
        expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
          MessageType.OK,
          event.id,
          false,
          Sinon.match(/invalid:.*64-character/),
        ])
      })

      it('accepts all valid lowercase hex characters (0-9 and a-f)', async () => {
        event.tags = [['h', '0123456789abcdef'.repeat(4)]]
        eventRepositoryCreateStub.resolves(1)

        await strategy.execute(event)

        expect(eventRepositoryCreateStub).to.have.been.calledOnce
      })
    })
  })
})
