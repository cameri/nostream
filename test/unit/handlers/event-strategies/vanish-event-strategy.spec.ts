import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import { Event } from '../../../../src/@types/event'
import { EventKinds } from '../../../../src/constants/base'
import { IWebSocketAdapter } from '../../../../src/@types/adapters'
import { MessageType } from '../../../../src/@types/messages'
import Sinon from 'sinon'
import { VanishEventStrategy } from '../../../../src/handlers/event-strategies/vanish-event-strategy'
import { WebSocketAdapterEvent } from '../../../../src/constants/adapter'

chai.use(chaiAsPromised)

const { expect } = chai

describe('VanishEventStrategy', () => {
  let webSocket: IWebSocketAdapter
  let eventRepository: any
  let webSocketEmitStub: Sinon.SinonStub
  let strategy: VanishEventStrategy
  let sandbox: Sinon.SinonSandbox
  const event: Event = {
    id: 'id',
    pubkey: 'pubkey',
    kind: EventKinds.REQUEST_TO_VANISH,
    tags: [[ 'r', 'relay_url' ]],
  } as any

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    eventRepository = {
      deleteByPubkeyExceptKinds: sandbox.stub().resolves(1),
      create: sandbox.stub().resolves(1),
    }
    webSocketEmitStub = sandbox.stub()
    webSocket = {
      emit: webSocketEmitStub,
    } as any
    strategy = new VanishEventStrategy(webSocket, eventRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('deletes all events for pubkey except kind 62 events and creates the vanish event', async () => {
    await strategy.execute(event)

    expect(eventRepository.deleteByPubkeyExceptKinds).to.have.been.calledOnceWithExactly(
      event.pubkey,
      [EventKinds.REQUEST_TO_VANISH],
    )
    expect(eventRepository.create).to.have.been.calledOnceWithExactly(event)
    expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
      WebSocketAdapterEvent.Message,
      [MessageType.OK, event.id, true, ''],
    )
  })

  it('does not broadcast the vanish event', async () => {
    await strategy.execute(event)

    expect(webSocketEmitStub.calledWith(WebSocketAdapterEvent.Broadcast)).to.be.false
  })

  it('returns duplicate OK if the event already exists', async () => {
    eventRepository.create.resolves(0)

    await strategy.execute(event)

    expect(webSocketEmitStub).to.have.been.calledOnceWithExactly(
      WebSocketAdapterEvent.Message,
      [MessageType.OK, event.id, true, 'duplicate:'],
    )
  })
})
