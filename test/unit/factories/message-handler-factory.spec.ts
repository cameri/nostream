import { expect } from 'chai'

import { IEventRepository, INip05VerificationRepository, IUserRepository } from '../../../src/@types/repositories'
import { IncomingMessage, MessageType } from '../../../src/@types/messages'
import { Event } from '../../../src/@types/event'
import { EventMessageHandler } from '../../../src/handlers/event-message-handler'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { messageHandlerFactory } from '../../../src/factories/message-handler-factory'
import { CountMessageHandler } from '../../../src/handlers/count-message-handler'
import { SubscribeMessageHandler } from '../../../src/handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from '../../../src/handlers/unsubscribe-message-handler'
import * as cacheModule from '../../../src/cache/client'
import sinon from 'sinon'

describe('messageHandlerFactory', () => {
  let event: Event
  let eventRepository: IEventRepository
  let userRepository: IUserRepository
  let nip05VerificationRepository: INip05VerificationRepository
  let message: IncomingMessage
  let adapter: IWebSocketAdapter
  let factory
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.stub(cacheModule, 'getCacheClient').returns({
      connect: async () => {},
      on: function () {
        return this
      },
      once: function () {
        return this
      },
      removeListener: function () {
        return this
      },
    } as any)
    eventRepository = {} as any
    userRepository = {} as any
    nip05VerificationRepository = {} as any
    adapter = {} as any
    event = {
      tags: [],
    } as any
    factory = messageHandlerFactory(eventRepository, userRepository, nip05VerificationRepository)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns EventMessageHandler when given an EVENT message', () => {
    message = [MessageType.EVENT, event]

    expect(factory([message, adapter])).to.be.an.instanceOf(EventMessageHandler)
  })

  it('returns SubscribeMessageHandler when given a REQ message', () => {
    message = [MessageType.REQ, '', {}] as any

    expect(factory([message, adapter])).to.be.an.instanceOf(SubscribeMessageHandler)
  })

  it('returns UnsubscribeMessageHandler when given a REQ message', () => {
    message = [MessageType.CLOSE, '']

    expect(factory([message, adapter])).to.be.an.instanceOf(UnsubscribeMessageHandler)
  })

  it('returns CountMessageHandler when given a COUNT message', () => {
    message = [MessageType.COUNT, 'q1', {}] as any

    expect(factory([message, adapter])).to.be.an.instanceOf(CountMessageHandler)
  })

  it('throws when given an invalid message', () => {
    message = [] as any

    expect(() => factory([message, adapter])).to.throw(Error, 'Unknown message type: undefined')
  })
})
