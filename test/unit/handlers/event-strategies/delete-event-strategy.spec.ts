import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

import { DatabaseClient } from '../../../../src/@types/base'
import { DeleteEventStrategy } from '../../../../src/handlers/event-strategies/delete-event-strategy'
import { Event } from '../../../../src/@types/event'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { EventTags } from '../../../../src/constants/base'
import { IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

const { expect } = chai

describe('DeleteEventStrategy', () => {
  const event: Event = {
    id: 'id',
    pubkey: 'pubkey',
    tags: [
      [EventTags.Event, '00000000'.repeat(8)],
      [EventTags.Event, 'ffffffff'.repeat(8)],
    ],
  } as any
  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository

  let webSocketEmitStub: Sinon.SinonStub
  let eventRepositoryCreateStub: Sinon.SinonStub
  let eventRepositoryDeleteByPubkeyAndIdsStub: Sinon.SinonStub

  let strategy: IEventStrategy<Event, Promise<void>>

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    eventRepositoryCreateStub = sandbox.stub(EventRepository.prototype, 'create')
    eventRepositoryDeleteByPubkeyAndIdsStub = sandbox.stub(EventRepository.prototype, 'deleteByPubkeyAndIds')

    webSocketEmitStub = sandbox.stub()
    webSocket = {
      emit: webSocketEmitStub,
    } as any
    const masterClient: DatabaseClient = {} as any
    const readReplicaClient: DatabaseClient = {} as any
    eventRepository = new EventRepository(masterClient, readReplicaClient)

    strategy = new DeleteEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    it('creates event', async () => {
      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
    })

    it('deletes events if it has e tags', async () => {
      await strategy.execute(event)

      expect(eventRepositoryDeleteByPubkeyAndIdsStub).to.have.been.calledOnceWithExactly(event.pubkey, [
        '0000000000000000000000000000000000000000000000000000000000000000',
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      ])
    })

    it('asks for each id once, in the order it first appears', async () => {
      const a = 'a'.repeat(64)
      const b = 'b'.repeat(64)
      const c = 'c'.repeat(64)
      const repeating: Event = {
        ...event,
        tags: [
          [EventTags.Event, b],
          [EventTags.Event, a],
          [EventTags.Event, b],
          [EventTags.Event, c],
          [EventTags.Event, a],
        ],
      }

      await strategy.execute(repeating)

      expect(eventRepositoryDeleteByPubkeyAndIdsStub).to.have.been.calledOnceWithExactly(event.pubkey, [b, a, c])
    })

    it('ignores tags that are not a valid e tag', async () => {
      const valid = 'd'.repeat(64)
      const mixed: Event = {
        ...event,
        tags: [
          [EventTags.Pubkey, 'e'.repeat(64)],
          [EventTags.Event] as any,
          [EventTags.Event, 'not-an-id'],
          [EventTags.Event, 'D'.repeat(64)],
          [EventTags.Event, valid, 'wss://relay.example'],
        ],
      }

      await strategy.execute(mixed)

      expect(eventRepositoryDeleteByPubkeyAndIdsStub).to.have.been.calledOnceWithExactly(event.pubkey, [valid])
    })

    it('does not delete anything when no tag is a valid e tag', async () => {
      await strategy.execute({ ...event, tags: [[EventTags.Event, 'not-an-id'], [EventTags.Pubkey, 'f'.repeat(64)]] })

      expect(eventRepositoryDeleteByPubkeyAndIdsStub).not.to.have.been.called
      expect(eventRepositoryCreateStub).to.have.been.calledOnce
    })

    it('handles an event with as many e tags as the largest message allows', async () => {
      const many = 7000
      const big: Event = {
        ...event,
        tags: Array.from({ length: many }, (_, i) => [EventTags.Event, i.toString(16).padStart(64, '0')]),
      }

      await strategy.execute(big)

      const [, ids] = eventRepositoryDeleteByPubkeyAndIdsStub.firstCall.args
      expect(ids).to.have.length(many)
      expect(ids[0]).to.equal('0'.repeat(64))
      expect(ids[many - 1]).to.equal((many - 1).toString(16).padStart(64, '0'))
    })

    it('does not delete events if there are no e tags', async () => {
      event.tags = []

      await strategy.execute(event)

      expect(eventRepositoryDeleteByPubkeyAndIdsStub).not.to.have.been.called
    })

    it('broadcast event if created', async () => {
      eventRepositoryCreateStub.resolves(1)

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).to.have.been.calledTwice
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'id',
        true,
        '',
      ])
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Broadcast, event)
    })

    it('does not broadcast event if duplicate', async () => {
      eventRepositoryCreateStub.resolves(0)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'id',
        true,
        'duplicate:',
      ])
    })

    it('rejects if unable to create event', async () => {
      const error = new Error()
      eventRepositoryCreateStub.rejects(error)

      await expect(strategy.execute(event)).to.eventually.be.rejectedWith(error)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      expect(eventRepositoryDeleteByPubkeyAndIdsStub).not.to.have.been.called
      expect(webSocketEmitStub).not.to.have.been.called
    })
  })
})
