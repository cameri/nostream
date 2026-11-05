import { expect } from 'chai'
import Sinon from 'sinon'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { IMessageHandler } from '../../../src/@types/message-handlers'
import { MessageType, UnsubscribeMessage } from '../../../src/@types/messages'
import { UnsubscribeMessageHandler } from '../../../src/handlers/unsubscribe-message-handler'

describe('UnsubscribeMessageHandler', () => {
  let handler: IMessageHandler
  let websocketAdapter: IWebSocketAdapter
  let endSubscriptionStub: Sinon.SinonStub

  beforeEach(() => {
    endSubscriptionStub = Sinon.stub()
    websocketAdapter = {
      endSubscription: endSubscriptionStub,
    } as any
    handler = new UnsubscribeMessageHandler(websocketAdapter)
  })

  describe('handleMessage()', () => {
    it('ends the subscription and aborts its in-flight read', async () => {
      const message: UnsubscribeMessage = [MessageType.CLOSE, 'subscriptionId']
      await handler.handleMessage(message)

      expect(endSubscriptionStub).to.have.been.calledOnceWithExactly('subscriptionId')
    })
  })
})
