import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import EventEmitter from 'events'
import Sinon from 'sinon'

chai.use(chaiAsPromised)

import { IncomingEventMessage, MessageType } from '../../../src/@types/messages'
import { DelegatedEventMessageHandler } from '../../../src/handlers/delegated-event-message-handler'
import { Event } from '../../../src/@types/event'
import { EventMessageHandler } from '../../../src/handlers/event-message-handler'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

const { expect } = chai

describe('DelegatedEventMessageHandler', () => {
  let webSocket: EventEmitter
  let handler: DelegatedEventMessageHandler
  let event: Event
  let message: IncomingEventMessage
  let sandbox: Sinon.SinonSandbox

  let originalConsoleWarn: (message?: any, ...optionalParams: any[]) => void | undefined = undefined

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    originalConsoleWarn = console.warn
    console.warn = () => undefined
    event = {
      content: 'hello',
      created_at: 1665546189,
      id: 'f'.repeat(64),
      kind: 1,
      pubkey: 'f'.repeat(64),
      sig: 'f'.repeat(128),
      tags: [
        ['delegation', 'delegator', 'rune', 'signature'],
      ],
    }
  })

  afterEach(() => {
    console.warn = originalConsoleWarn
    sandbox.restore()
  })

  describe('handleMessage', () => {
    let canAcceptEventStub: Sinon.SinonStub
    let isEventValidStub: Sinon.SinonStub
    let strategyFactoryStub: Sinon.SinonStub
    let onMessageSpy: Sinon.SinonSpy
    let strategyExecuteStub: Sinon.SinonStub
    let isRateLimitedStub: Sinon.SinonStub

    beforeEach(() => {
      canAcceptEventStub = sandbox.stub(DelegatedEventMessageHandler.prototype, 'canAcceptEvent' as any)
      isEventValidStub = sandbox.stub(DelegatedEventMessageHandler.prototype, 'isEventValid' as any)
      strategyExecuteStub = sandbox.stub()
      strategyFactoryStub = sandbox.stub().returns({
        execute: strategyExecuteStub,
      })
      onMessageSpy = sandbox.fake.returns(undefined)
      webSocket = new EventEmitter()
      webSocket.on(WebSocketAdapterEvent.Message, onMessageSpy)
      message = [MessageType.EVENT, event]
      isRateLimitedStub = sandbox.stub(EventMessageHandler.prototype, 'isRateLimited' as any)
      handler = new DelegatedEventMessageHandler(
        webSocket as any,
        strategyFactoryStub,
        () => ({}) as any,
        () => ({ hit: async () => false }),
      )
    })

    afterEach(() => {
      isEventValidStub.restore()
      canAcceptEventStub.restore()
      webSocket.removeAllListeners()
    })

    it('rejects event if it can\'t be accepted', async () => {
      canAcceptEventStub.returns('reason')

      await handler.handleMessage(message)

      expect(canAcceptEventStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).to.have.been.calledOnceWithExactly(
        [
          MessageType.OK,
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          false,
          'reason',
        ],
      )
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if invalid', async () => {
      isEventValidStub.returns('reason')

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('rejects event if rate-limited', async () => {
      isRateLimitedStub.resolves(true)

      await handler.handleMessage(message)

      expect(isRateLimitedStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).to.have.been.calledOnceWithExactly(
        [MessageType.OK, event.id, false, 'rate-limited: slow down'],
      )
      expect(strategyFactoryStub).not.to.have.been.called
    })

    it('does not call strategy if none given', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)
      strategyFactoryStub.returns(undefined)

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).to.have.been.calledOnceWithExactly([
        event,
        webSocket,
      ])
      expect(strategyExecuteStub).not.to.have.been.called
    })

    it('calls strategy with event', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)

      await handler.handleMessage(message)

      expect(isEventValidStub).to.have.been.calledOnceWithExactly(event)
      expect(onMessageSpy).not.to.have.been.calledOnceWithExactly()
      expect(strategyFactoryStub).to.have.been.calledOnceWithExactly([
        event,
        webSocket,
      ])
      expect(strategyExecuteStub).to.have.been.calledOnceWithExactly(event)
    })

    it('does not reject if strategy rejects', async () => {
      isEventValidStub.returns(undefined)
      canAcceptEventStub.returns(undefined)
      strategyExecuteStub.rejects()

      return expect(handler.handleMessage(message)).to.eventually.be.fulfilled
    })
  })

  describe('isEventValid', () => {
    let parentIsEventValidStub: Sinon.SinonStub

    beforeEach(() => {
      parentIsEventValidStub = Sinon.stub(EventMessageHandler.prototype, 'isEventValid' as any)
      event = {
        'id': 'a080fd288b60ac2225ff2e2d815291bd730911e583e177302cc949a15dc2b2dc',
        'pubkey': '62903b1ff41559daf9ee98ef1ae67cc52f301bb5ce26d14baba3052f649c3f49',
        'created_at': 1660896109,
        'kind': 1,
        'tags': [
          [
            'delegation',
            '86f0689bd48dcd19c67a19d994f938ee34f251d8c39976290955ff585f2db42e',
            'kind=1&created_at>1640995200',
            'c33c88ba78ec3c760e49db591ac5f7b129e3887c8af7729795e85a0588007e5ac89b46549232d8f918eefd73e726cb450135314bfda419c030d0b6affe401ec1',
          ],
        ],
        'content': 'Hello world',
        'sig': 'cd4a3cd20dc61dcbc98324de561a07fd23b3d9702115920c0814b5fb822cc5b7c5bcdaf3fa326d24ed50c5b9c8214d66c75bae34e3a84c25e4d122afccb66eb6',
      }
    })

    afterEach(() => {
      parentIsEventValidStub.restore()
    })

    it('returns undefined if event and delegate tag is valid', async () => {
      parentIsEventValidStub.resolves(undefined)

      expect(await (handler as any).isEventValid(event)).to.be.undefined
    })

    it('returns reason if event is not valid', () => {
      parentIsEventValidStub.resolves('reason')
      return expect((handler as any).isEventValid(event)).to.eventually.equal('reason')
    })

    it('returns reason if delegate signature is not valid', () => {
      parentIsEventValidStub.resolves(undefined)

      event.tags[0][3] = 'wrong sig'
      return expect((handler as any).isEventValid(event)).to.eventually.equal('invalid: delegation verification failed')
    })
  })
})
