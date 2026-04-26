import chai from 'chai'
import EventEmitter from 'events'
import Sinon from 'sinon'
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
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    eventRepository = {
      countByFilters: sandbox.stub().resolves(7),
    } as any

    webSocket = new EventEmitter() as any

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

  describe('handleMessage()', () => {
    let webSocketOnMessageStub: Sinon.SinonStub

    beforeEach(() => {
      webSocketOnMessageStub = sandbox.stub()
      webSocket.on(WebSocketAdapterEvent.Message, webSocketOnMessageStub)
    })

    it('returns COUNT with the result when counting works', async () => {
      const message = [MessageType.COUNT, 'q1', {}] as any

      await handler.handleMessage(message)

      expect(eventRepository.countByFilters).to.have.been.calledOnceWithExactly([{}])
      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly([MessageType.COUNT, 'q1', { count: 7 }])
    })

    it('drops duplicate filters before querying the repository', async () => {
      const repeatedFilter = { kinds: [1] }
      const message = [MessageType.COUNT, 'q1', repeatedFilter, repeatedFilter] as any

      await handler.handleMessage(message)

      expect(eventRepository.countByFilters).to.have.been.calledOnceWithExactly([repeatedFilter])
      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly([MessageType.COUNT, 'q1', { count: 7 }])
    })

    it('returns CLOSED when the request has too many filters', async () => {
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
      expect(webSocketOnMessageStub).to.have.been.calledOnce
      expect(webSocketOnMessageStub.firstCall.args[0][0]).to.equal(MessageType.CLOSED)
      expect(webSocketOnMessageStub.firstCall.args[0][1]).to.equal('q1')
    })

    it('returns CLOSED when the query ID is too long', async () => {
      handler = new CountMessageHandler(webSocket, eventRepository, () => ({
        limits: {
          client: {
            subscription: {
              maxFilters: 10,
              maxSubscriptionIdLength: 2,
            },
          },
        },
      }) as Settings)

      const message = [MessageType.COUNT, 'q123', {}] as any

      await handler.handleMessage(message)

      expect(eventRepository.countByFilters).to.not.have.been.called
      expect(webSocketOnMessageStub).to.have.been.calledOnce
      expect(webSocketOnMessageStub.firstCall.args[0][0]).to.equal(MessageType.CLOSED)
      expect(webSocketOnMessageStub.firstCall.args[0][1]).to.equal('q123')
    })

    it('returns CLOSED when counting fails in the repository', async () => {
      const countByFiltersStub = eventRepository.countByFilters as Sinon.SinonStub
      countByFiltersStub.rejects(new Error('boom'))
      const message = [MessageType.COUNT, 'q1', {}] as any

      await handler.handleMessage(message)

      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly([
        MessageType.CLOSED,
        'q1',
        'error: unable to count events',
      ])
    })

    it('returns CLOSED when COUNT is disabled in settings', async () => {
      handler = new CountMessageHandler(webSocket, eventRepository, () => ({ nip45: { enabled: false } }) as Settings)

      const message = [MessageType.COUNT, 'q1', {}] as any

      await handler.handleMessage(message)

      expect(eventRepository.countByFilters).to.not.have.been.called
      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly([
        MessageType.CLOSED,
        'q1',
        'COUNT is disabled by relay configuration',
      ])
    })
  })
})
