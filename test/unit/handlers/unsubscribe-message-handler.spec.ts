import { expect } from 'chai'
import Sinon from 'sinon'

import { MessageType, UnsubscribeMessage } from '../../../src/@types/messages'
import { IMessageHandler } from '../../../src/@types/message-handlers'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { UnsubscribeMessageHandler } from '../../../src/handlers/unsubscribe-message-handler'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

describe('UnsubscribeMessageHandler', () => {
  let handler: IMessageHandler
  let websocketAdapter: IWebSocketAdapter
  let emitStub: Sinon.SinonStub
  beforeEach(() => {
    emitStub = Sinon.stub()
    websocketAdapter = {
      emit: emitStub,
    } as any
    handler = new UnsubscribeMessageHandler(websocketAdapter)
  })

  describe('handleMessage()', () => {
    it('emits unsubscribe event with subscription Id', async () => {
      const message: UnsubscribeMessage = [MessageType.CLOSE, 'subscriptionId']
      await handler.handleMessage(message)

      expect(emitStub).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Unsubscribe, 'subscriptionId')
    })
  })
})
