import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

import { DatabaseClient } from '../../../../src/@types/base'
import { Event } from '../../../../src/@types/event'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { ReplaceableEventStrategy } from '../../../../src/handlers/event-strategies/replaceable-event-strategy'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

const { expect } = chai

describe('ReplaceableEventStrategy', () => {
  const event: Event = {
    id: 'id',
  } as any
  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository

  let webSocketEmitStub: Sinon.SinonStub
  let eventRepositoryUpsertStub: Sinon.SinonStub

  let strategy: IEventStrategy<Event, Promise<void>>

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    eventRepositoryUpsertStub = sandbox.stub(EventRepository.prototype, 'upsert')

    webSocketEmitStub = sandbox.stub()
    webSocket = {
      emit: webSocketEmitStub,
    } as any
    const masterClient: DatabaseClient = {} as any
    const readReplicaClient: DatabaseClient = {} as any
    eventRepository = new EventRepository(masterClient, readReplicaClient)

    strategy = new ReplaceableEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    it('upserts event', async () => {
      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
    })

    it('broadcast event if event is created', async () => {
      eventRepositoryUpsertStub.resolves(1)

      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
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

    it('does not broadcast event if event is duplicate', async () => {
      eventRepositoryUpsertStub.resolves(0)

      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
        WebSocketAdapterEvent.Message,
        ['OK', 'id', true, 'duplicate:']
      )
    })

    it('rejects if unable to upsert event', async () => {
      const error = new Error()
      eventRepositoryUpsertStub.rejects(error)

      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
        WebSocketAdapterEvent.Message,
        ['OK', 'id', false, 'error: ']
      )
    })
  })
})
