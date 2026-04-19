import chai from 'chai'
import EventEmitter from 'events'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { MessageType } from '../../../src/@types/messages'
import { IEventRepository } from '../../../src/@types/repositories'
import { Settings } from '../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'
import { CountMessageHandler } from '../../../src/handlers/count-message-handler'

chai.use(sinonChai)
const { expect } = chai

describe('CountMessageHandler', () => {
  let webSocket: IWebSocketAdapter
  let handler: CountMessageHandler
  let eventRepository: IEventRepository
  let onMessageStub: sinon.SinonStub
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    eventRepository = {
      countByFilters: sandbox.stub().resolves(7),
    } as any

    webSocket = new EventEmitter() as any
    onMessageStub = sandbox.stub()
    webSocket.on(WebSocketAdapterEvent.Message, onMessageStub)

    handler = new CountMessageHandler(webSocket, eventRepository, () => ({
      limits: {
        client: {
          subscription: {
            maxFilters: 10,
            maxSubscriptionIdLength: 256,
          },
        },
      },
    }) as Settings)
  })

  afterEach(() => {
    webSocket.removeAllListeners()
    sandbox.restore()
  })

  it('emits COUNT message with count on success', async () => {
    const message = [MessageType.COUNT, 'q1', {}] as any

    await handler.handleMessage(message)

    expect(eventRepository.countByFilters).to.have.been.calledOnceWithExactly([{}])
    expect(onMessageStub).to.have.been.calledOnceWithExactly([MessageType.COUNT, 'q1', { count: 7 }])
  })

  it('emits CLOSED message when request is rejected', async () => {
    handler = new CountMessageHandler(webSocket, eventRepository, () => ({
      limits: {
        client: {
          subscription: {
            maxFilters: 1,
            maxSubscriptionIdLength: 256,
          },
        },
      },
    }) as Settings)

    const message = [MessageType.COUNT, 'q1', { kinds: [1] }, { kinds: [2] }] as any

    await handler.handleMessage(message)

    expect(eventRepository.countByFilters).to.not.have.been.called
    expect(onMessageStub).to.have.been.calledOnce
    expect(onMessageStub.firstCall.args[0][0]).to.equal(MessageType.CLOSED)
    expect(onMessageStub.firstCall.args[0][1]).to.equal('q1')
  })

  it('emits CLOSED message when repository fails', async () => {
    (eventRepository.countByFilters as sinon.SinonStub).rejects(new Error('boom'))
    const message = [MessageType.COUNT, 'q1', {}] as any

    await handler.handleMessage(message)

    expect(onMessageStub).to.have.been.calledOnceWithExactly([
      MessageType.CLOSED,
      'q1',
      'error: unable to count events',
    ])
  })
})
