import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import { VanishEventStrategy } from '../../../../src/handlers/event-strategies/vanish-event-strategy'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(chaiAsPromised)
chai.use(sinonChai)

const { expect } = chai

describe('VanishEventStrategy', () => {
  let webSocket: IWebSocketAdapter
  let eventRepository: any
  let userRepository: any
  let webSocketEmitStub: Sinon.SinonStub
  let strategy: VanishEventStrategy
  let sandbox: Sinon.SinonSandbox
  const event: Event = {
    id: 'id',
    pubkey: 'pubkey',
    kind: EventKinds.REQUEST_TO_VANISH,
    tags: [['r', 'relay_url']],
  } as any

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    eventRepository = {
      deleteByPubkeyExceptKinds: sandbox.stub().resolves(1),
      create: sandbox.stub().resolves(1),
    }
    userRepository = {
      setVanished: sandbox.stub().resolves(1),
    }
    webSocketEmitStub = sandbox.stub()
    webSocket = {
      emit: webSocketEmitStub,
    } as any
    strategy = new VanishEventStrategy(webSocket, eventRepository, userRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('deletes all events for pubkey except kind 62 events and creates the vanish event', async () => {
    await strategy.execute(event)

    expect(eventRepository.deleteByPubkeyExceptKinds).to.have.been.calledOnceWithExactly(event.pubkey, [
      EventKinds.REQUEST_TO_VANISH,
    ])
    expect(eventRepository.create).to.have.been.calledOnceWithExactly(event)
    expect(userRepository.setVanished).to.have.been.calledOnceWithExactly(event.pubkey, true)
    expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
      MessageType.OK,
      event.id,
      true,
      '',
    ])
  })

  it('does not broadcast the vanish event', async () => {
    await strategy.execute(event)

    expect(webSocketEmitStub.calledWith(WebSocketAdapterEvent.Broadcast)).to.be.false
  })

  it('returns duplicate OK if the event already exists', async () => {
    eventRepository.create.resolves(0)

    await strategy.execute(event)

    expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Message, [
      MessageType.OK,
      event.id,
      true,
      'duplicate:',
    ])
  })

  describe('membership list', () => {
    let refresh: Sinon.SinonStub

    beforeEach(() => {
      refresh = sandbox.stub().resolves()
      strategy = new VanishEventStrategy(webSocket, eventRepository, userRepository, { refresh } as any)
    })

    it('refreshes the membership list once the user is marked as vanished', async () => {
      await strategy.execute(event)

      expect(refresh).to.have.been.calledOnce
      expect(refresh).to.have.been.calledAfter(userRepository.setVanished)
    })

    it('still completes the vanish and answers OK when the refresh fails', async () => {
      refresh.rejects(new Error('db down'))

      await strategy.execute(event)

      expect(userRepository.setVanished).to.have.been.calledOnceWithExactly(event.pubkey, true)
      expect(webSocketEmitStub).to.have.been.calledOnce
    })

    it('does not refresh when the vanish could not be completed', async () => {
      userRepository.setVanished.rejects(new Error('db down'))

      await expect(strategy.execute(event)).to.be.rejectedWith('db down')

      expect(refresh).not.to.have.been.called
    })

    it('works without a membership list publisher', async () => {
      strategy = new VanishEventStrategy(webSocket, eventRepository, userRepository)

      await strategy.execute(event)

      expect(webSocketEmitStub).to.have.been.calledOnce
    })
  })
})
