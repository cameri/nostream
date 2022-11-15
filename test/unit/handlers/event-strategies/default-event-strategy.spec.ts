import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

import { DatabaseClient } from '../../../../src/@types/base'
import { DefaultEventStrategy } from '../../../../src/handlers/event-strategies/default-event-strategy'
import { Event } from '../../../../src/@types/event'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

const { expect } = chai

describe('DefaultEventStrategy', () => {
  const event: Event = {
    id: 'id',
  } as any
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
    webSocket = {
      emit: webSocketEmitStub,
    } as any
    const client: DatabaseClient = {} as any
    eventRepository = new EventRepository(client)

    strategy = new DefaultEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    it('creates event', async () => {
      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
    })

    it('broadcast event if event is created', async () => {
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

    it('does not broadcast event if event is duplicate', async () => {
      eventRepositoryCreateStub.resolves(0)

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
        WebSocketAdapterEvent.Message,
        ['OK', 'id', true, 'duplicate:']
      )
    })

    it('rejects if unable to create event', async () => {
      const error = new Error()
      eventRepositoryCreateStub.rejects(error)

      await expect(strategy.execute(event)).to.eventually.be.rejectedWith(error)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).not.to.have.been.called
    })
  })
})
