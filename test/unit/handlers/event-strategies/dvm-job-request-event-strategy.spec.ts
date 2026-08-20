import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

const { expect } = chai

import { DvmJobRequestEventStrategy } from '../../../../src/handlers/event-strategies/dvm-job-request-event-strategy'
import { Event } from '../../../../src/@types/event'
import { IDvmJobRepository, IEventRepository } from '../../../../src/@types/repositories'
import { IEventStrategy } from '../../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

describe('DvmJobRequestEventStrategy', () => {
  const event: Event = {
    id: 'event-id',
    pubkey: 'requester-pubkey',
    kind: 5000,
  } as any

  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository
  let dvmJobRepository: IDvmJobRepository

  let webSocketEmitStub: Sinon.SinonStub
  let eventRepositoryCreateStub: Sinon.SinonStub
  let dvmJobRepositoryCreateStub: Sinon.SinonStub

  let strategy: IEventStrategy<Event, Promise<void>>

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    webSocketEmitStub = sandbox.stub()
    webSocket = {
      emit: webSocketEmitStub,
    } as any

    eventRepositoryCreateStub = sandbox.stub()
    eventRepository = {
      create: eventRepositoryCreateStub,
    } as any

    dvmJobRepositoryCreateStub = sandbox.stub()
    dvmJobRepository = {
      create: dvmJobRepositoryCreateStub,
    } as any

    strategy = new DvmJobRequestEventStrategy(webSocket, eventRepository, dvmJobRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('execute', () => {
    it('creates the event', async () => {
      eventRepositoryCreateStub.resolves(1)
      dvmJobRepositoryCreateStub.resolves({})

      await strategy.execute(event)

      expect(eventRepositoryCreateStub).to.have.been.calledOnceWithExactly(event)
    })

    it('records a dvm job when the event is newly created', async () => {
      eventRepositoryCreateStub.resolves(1)
      dvmJobRepositoryCreateStub.resolves({})

      await strategy.execute(event)

      expect(dvmJobRepositoryCreateStub).to.have.been.calledOnceWithExactly('event-id', 'requester-pubkey', 5000)
    })

    it('broadcasts the event when newly created', async () => {
      eventRepositoryCreateStub.resolves(1)
      dvmJobRepositoryCreateStub.resolves({})

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        '',
      ])
      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Broadcast, event)
    })

    it('does not broadcast or record a job when the event is a duplicate', async () => {
      eventRepositoryCreateStub.resolves(0)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        'duplicate:',
      ])
      expect(dvmJobRepositoryCreateStub).not.to.have.been.called
    })

    it('does not reject the event when job recording fails', async () => {
      eventRepositoryCreateStub.resolves(1)
      dvmJobRepositoryCreateStub.rejects(new Error('db unavailable'))

      await expect(strategy.execute(event)).to.eventually.be.fulfilled

      expect(webSocketEmitStub).to.have.been.calledWithExactly(WebSocketAdapterEvent.Message, [
        MessageType.OK,
        'event-id',
        true,
        '',
      ])
    })

    it('rejects if unable to create the event', async () => {
      const error = new Error('event creation failed')
      eventRepositoryCreateStub.rejects(error)

      await expect(strategy.execute(event)).to.eventually.be.rejectedWith(error)

      expect(dvmJobRepositoryCreateStub).not.to.have.been.called
    })
  })
})
