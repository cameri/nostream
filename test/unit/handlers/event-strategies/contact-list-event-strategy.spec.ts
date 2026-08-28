import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

const { expect } = chai

import { ContactListEventStrategy } from '../../../../src/handlers/event-strategies/contact-list-event-strategy'
import { Event } from '../../../../src/@types/event'
import { IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { IWotGraphService } from '../../../../src/@types/services'
import { MessageType } from '../../../../src/@types/messages'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

describe('ContactListEventStrategy', () => {
  const event: Event = {
    id: 'event-id',
    pubkey: 'author-pubkey',
    kind: 3,
    tags: [
      ['p', 'followed-1'],
      ['p', 'followed-2'],
      ['e', 'not-a-follow'],
    ],
  } as any

  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository
  let wotGraphService: IWotGraphService

  let webSocketEmitStub: Sinon.SinonStub
  let eventRepositoryUpsertStub: Sinon.SinonStub
  let updateFollowListStub: Sinon.SinonStub

  let strategy: IEventStrategy<Event, Promise<void>>

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    webSocketEmitStub = sandbox.stub()
    webSocket = {
      emit: webSocketEmitStub,
    } as any

    eventRepositoryUpsertStub = sandbox.stub()
    eventRepository = {
      upsert: eventRepositoryUpsertStub,
    } as any

    updateFollowListStub = sandbox.stub()
    wotGraphService = {
      updateFollowList: updateFollowListStub,
    } as any

    strategy = new ContactListEventStrategy(webSocket, eventRepository, wotGraphService)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    it('upserts the event', async () => {
      eventRepositoryUpsertStub.resolves(1)
      updateFollowListStub.resolves()

      await strategy.execute(event)

      expect(eventRepositoryUpsertStub).to.have.been.calledOnceWithExactly(event)
    })

    it('updates the wot graph with the p-tagged pubkeys when newly stored', async () => {
      eventRepositoryUpsertStub.resolves(1)
      updateFollowListStub.resolves()

      await strategy.execute(event)

      expect(updateFollowListStub).to.have.been.calledOnceWithExactly('author-pubkey', ['followed-1', 'followed-2'])
    })

    it('broadcasts the event when newly stored', async () => {
      eventRepositoryUpsertStub.resolves(1)
      updateFollowListStub.resolves()

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        '',
      ])
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Broadcast, event)
    })

    it('does not broadcast or update the wot graph when the event is a duplicate', async () => {
      eventRepositoryUpsertStub.resolves(0)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        'duplicate:',
      ])
      expect(updateFollowListStub).not.to.have.been.called
    })

    it('does not fail the event when the wot graph update fails', async () => {
      eventRepositoryUpsertStub.resolves(1)
      updateFollowListStub.rejects(new Error('cache unavailable'))

      await expect(strategy.execute(event)).to.eventually.be.fulfilled

      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        '',
      ])
    })

    it('emits a rejection when the event already exists', async () => {
      eventRepositoryUpsertStub.rejects(
        new Error('duplicate key value violates unique constraint "events_event_id_unique"'),
      )

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        false,
        'rejected: event already exists',
      ])
      expect(updateFollowListStub).not.to.have.been.called
    })

    it('emits an error message on unexpected upsert failure', async () => {
      eventRepositoryUpsertStub.rejects(new Error('connection reset'))

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        false,
        'error: connection reset',
      ])
    })
  })
})
