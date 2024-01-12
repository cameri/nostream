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

      expect(eventRepositoryDeleteByPubkeyAndIdsStub).to.have.been.calledOnceWithExactly(
        event.pubkey,
        [
          '0000000000000000000000000000000000000000000000000000000000000000',
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        ]
      )
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
      expect(webSocketEmitStub).to.have.been.calledWithExactly(
        WebSocketAdapterEvent.Message,
        [MessageType.OK, 'id', true, '']
      )
      expect(webSocketEmitStub).to.have.been.calledWithExactly(
        WebSocketAdapterEvent.Broadcast,
        event
      )
    })

    it('does not broadcast event if duplicate', async () => {
      eventRepositoryCreateStub.resolves(0)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
        WebSocketAdapterEvent.Message,
        [MessageType.OK, 'id', true, 'duplicate:']
      )
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
