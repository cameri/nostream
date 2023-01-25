import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

import { EventDeduplicationMetadataKey, EventTags } from '../../../../src/constants/base'
import { DatabaseClient } from '../../../../src/@types/base'
import { Event } from '../../../../src/@types/event'
import { EventRepository } from '../../../../src/repositories/event-repository'
import { IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { ParameterizedReplaceableEventStrategy } from '../../../../src/handlers/event-strategies/parameterized-replaceable-event-strategy'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

const { expect } = chai

describe('ParameterizedReplaceableEventStrategy', () => {
  const event: Event = {
    id: 'id',
    tags: [
      [EventTags.Deduplication, 'dedup'],
    ],
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

    strategy = new ParameterizedReplaceableEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    it('upserts event without d tag', async () => {
      event.tags = []
      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
      expect(eventRepositoryUpsertStub.firstCall.firstArg).to.have.property(EventDeduplicationMetadataKey).and.deep.equal([''])
    })

    it('upserts event with d tag and one string', async () => {
      event.tags = [[EventTags.Deduplication, 'one']]
      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
      expect(eventRepositoryUpsertStub.firstCall.firstArg).to.have.property(EventDeduplicationMetadataKey).and.deep.equal(['one'])
    })

    it('upserts event with d tag and two strings', async () => {
      event.tags = [[EventTags.Deduplication, 'one', 'two']]
      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
      expect(eventRepositoryUpsertStub.firstCall.firstArg).to.have.property(EventDeduplicationMetadataKey).and.deep.equal(['one', 'two'])
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

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
        WebSocketAdapterEvent.Message,
        [MessageType.OK, 'id', true, 'duplicate:']
      )
    })

    it('rejects if unable to upsert event', async () => {
      const error = new Error()
      eventRepositoryUpsertStub.rejects(error)

      await expect(strategy.execute(event)).to.eventually.be.rejectedWith(error)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
      expect(webSocketEmitStub).not.to.have.been.called
    })
  })
})
