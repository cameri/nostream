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
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

const { expect } = chai

describe('DeleteEventStrategy', () => {
  const event: Event = {
    pubkey: 'pubkey',
    tags: [
      [EventTags.Event, 'event id 1'],
      [EventTags.Event, 'event id 2'],
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
    const client: DatabaseClient = {} as any
    eventRepository = new EventRepository(client)

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
        ['event id 1', 'event id 2'],
      )
    })

    it('does not delete events if there are no e tags', async () => {
      event.tags = []

      await strategy.execute(event)

      expect(eventRepositoryDeleteByPubkeyAndIdsStub).not.to.have.been.called
    })

    it('broadcast event', async () => {
      eventRepositoryCreateStub.resolves()

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
        WebSocketAdapterEvent.Broadcast,
        event
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
