import { expect } from 'chai'

import { IEventRepository, IUserRepository } from '../../../src/@types/repositories'
import { IncomingMessage, MessageType } from '../../../src/@types/messages'
import { Event } from '../../../src/@types/event'
import { EventMessageHandler } from '../../../src/handlers/event-message-handler'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { messageHandlerFactory } from '../../../src/factories/message-handler-factory'
import { SubscribeMessageHandler } from '../../../src/handlers/subscribe-message-handler'
import { UnsubscribeMessageHandler } from '../../../src/handlers/unsubscribe-message-handler'

describe('messageHandlerFactory', () => {
  let event: Event
  let eventRepository: IEventRepository
  let userRepository: IUserRepository
  let message: IncomingMessage
  let adapter: IWebSocketAdapter
  let factory

  beforeEach(() => {
    eventRepository = {} as any
    userRepository = {} as any
    adapter = {} as any
    event = {
      tags: [],
    } as any
    factory = messageHandlerFactory(eventRepository, userRepository)
  })

  it('returns EventMessageHandler when given an EVENT message', () => {
    message = [
       MessageType.EVENT,
       event,
    ]

    expect(factory([message, adapter])).to.be.an.instanceOf(EventMessageHandler)
  })

  it('returns SubscribeMessageHandler when given a REQ message', () => {
    message = [
       MessageType.REQ,
       '',
       {},
    ] as any

    expect(factory([message, adapter])).to.be.an.instanceOf(SubscribeMessageHandler)
  })

  it('returns UnsubscribeMessageHandler when given a REQ message', () => {
    message = [
       MessageType.CLOSE,
       '',
    ]

    expect(factory([message, adapter])).to.be.an.instanceOf(UnsubscribeMessageHandler)
  })

  it('throws when given an invalid message', () => {
    message = [] as any

    expect(() => factory([message, adapter])).to.throw(Error, 'Unknown message type: undefined')
  })


})