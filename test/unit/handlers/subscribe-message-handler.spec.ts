import { always } from 'ramda'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import EventEmitter from 'events'
import Sinon from 'sinon'

import { IAbortable, IMessageHandler } from '../../../src/@types/message-handlers'
import { MessageType, SubscribeMessage } from '../../../src/@types/messages'
import { SubscriptionFilter, SubscriptionId } from '../../../src/@types/subscription'
import { Event } from '../../../src/@types/event'
import { IEventRepository } from '../../../src/@types/repositories'
import { IWebSocketAdapter } from '../../../src/@types/adapters'
import { PassThrough } from 'stream'
import { SubscribeMessageHandler } from '../../../src/handlers/subscribe-message-handler'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

chai.use(chaiAsPromised)
const { expect } = chai

const toDbEvent = (event: Event) => ({
  event_id: Buffer.from(event.id, 'hex'),
  event_kind: event.kind,
  event_pubkey: Buffer.from(event.pubkey, 'hex'),
  event_created_at: event.created_at,
  event_content: event.content,
  event_tags: event.tags,
  event_signature: Buffer.from(event.sig, 'hex'),
})

describe('SubscribeMessageHandler', () => {
  const subscriptionId: SubscriptionId = 'subscriptionId'
  let filters: SubscriptionFilter[]
  let subscriptions: Map<SubscriptionId, SubscriptionFilter[]>
  let handler: IMessageHandler & IAbortable
  let webSocket: IWebSocketAdapter
  let eventRepository: IEventRepository
  let message: SubscribeMessage
  let stream: PassThrough
  let settingsFactory: Sinon.SinonStub
  let webSocketGetSubscriptionsStub: Sinon.SinonStub
  let eventRepositoryFindByFiltersStub: Sinon.SinonSpy

  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    filters = [{}]
    subscriptions = new Map()
    webSocket = new EventEmitter() as any
    webSocketGetSubscriptionsStub = sandbox.stub().returns(subscriptions)
    webSocket.getSubscriptions = webSocketGetSubscriptionsStub
    settingsFactory = sandbox.stub()
    stream = new PassThrough({
      objectMode: true,
    })
    eventRepositoryFindByFiltersStub = sandbox.fake.returns({
      stream: () => stream,
    })
    eventRepository = {
      findByFilters: eventRepositoryFindByFiltersStub,
    } as any
    handler = new SubscribeMessageHandler(
      webSocket,
      eventRepository,
      settingsFactory,
    )
  })

  afterEach(() => {
    sandbox.restore()
    webSocket.removeAllListeners()
  })

  describe('#handleMessage', () => {
    let webSocketOnMessageStub: Sinon.SinonStub
    let webSocketOnSubscribeStub: Sinon.SinonStub
    let canSubscribeStub: Sinon.SinonStub
    let fetchAndSendStub: Sinon.SinonStub

    beforeEach(() => {
      webSocketOnMessageStub = sandbox.stub()
      webSocketOnSubscribeStub = sandbox.stub()
      webSocket.on(WebSocketAdapterEvent.Message, webSocketOnMessageStub)
      webSocket.on(WebSocketAdapterEvent.Subscribe, webSocketOnSubscribeStub)

      fetchAndSendStub = sandbox.stub(SubscribeMessageHandler.prototype, 'fetchAndSend' as any)
      canSubscribeStub = sandbox.stub(SubscribeMessageHandler.prototype, 'canSubscribe' as any)
    })

    it('emits notice message if subscription is rejected', async () => {
      canSubscribeStub.returns('reason')
      message = [MessageType.REQ, subscriptionId, ...filters] as any

      await handler.handleMessage(message)

      expect(webSocketOnMessageStub).to.have.been.calledOnceWithExactly(
        ['NOTICE', 'Subscription rejected: reason']
      )
    })

    it('emits subscribe event if subscription is accepted', async () => {
      canSubscribeStub.returns(undefined)
      message = [MessageType.REQ, subscriptionId, ...filters] as any

      await handler.handleMessage(message)

      expect(webSocketOnSubscribeStub).to.have.been.calledOnceWith(subscriptionId)
      expect(fetchAndSendStub).to.have.been.calledOnceWithExactly(subscriptionId, filters)
    })

  })

  describe('#fetchAndSend', () => {
    let event: Event
    let webSocketOnMessageStub: Sinon.SinonStub
    let webSocketOnSubscribeStub: Sinon.SinonStub
    let isClientSubscribedToEventStub: Sinon.SinonStub

    beforeEach(() => {
      event = {
        'id': 'b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef',
        'pubkey': '22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793',
        'created_at': 1648339664,
        'kind': 1,
        'tags': [],
        'content': 'learning terraform rn!',
        'sig': 'ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848',
      }

      isClientSubscribedToEventStub = sandbox.stub(SubscribeMessageHandler, 'isClientSubscribedToEvent' as any)

      webSocketOnMessageStub = sandbox.stub()
      webSocketOnSubscribeStub = sandbox.stub()
      webSocket.on(WebSocketAdapterEvent.Message, webSocketOnMessageStub)
      webSocket.on(WebSocketAdapterEvent.Subscribe, webSocketOnSubscribeStub)
      //streamEndSpy = sandbox.spy(Stream, '_end' as any)
    })

    it('does not send event if client is not subscribed to it', async () => {
      isClientSubscribedToEventStub.returns(always(false))

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.write(toDbEvent(event))
      stream.end()

      await promise

      expect(eventRepositoryFindByFiltersStub).to.have.been.calledOnceWithExactly(filters)
    })

    it('sends event if client is subscribed', async () => {
      isClientSubscribedToEventStub.returns(always(true))

      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.write(toDbEvent(event))
      stream.end()

      await promise

      expect(eventRepositoryFindByFiltersStub).to.have.been.calledOnceWithExactly(filters)
      expect(webSocketOnMessageStub).to.have.been.calledWithExactly(
        ['EVENT', subscriptionId, event],
      )
    })

    it('sends EOSE', async () => {
      const promise = (handler as any).fetchAndSend(subscriptionId, filters)

      stream.end()

      await promise

      expect(webSocketOnMessageStub).to.have.been.calledWithExactly(
        ['EOSE', subscriptionId],
      )
    })

    it('ends event stream if error occurs', async () => {
      const error = new Error('mistakes were made')
      isClientSubscribedToEventStub.returns(always(true))

      const fetch = () => (handler as any).fetchAndSend(subscriptionId, filters)

      const promise = fetch()

      stream.emit('error', error)

      const closeSpy = sandbox.spy()
      stream.once('close', closeSpy)

      await expect(promise).to.eventually.be.rejectedWith(error)
      expect(closeSpy).to.have.been.called
    })
  })

  describe('.isClientSubscribedToEvent', () => {
    it('returns false if event matches no filter', () => {
      const filters: SubscriptionFilter[] = [{ ids: ['aa'] }]
      const event: Event = { id: 'bb' } as any

      expect((SubscribeMessageHandler as any).isClientSubscribedToEvent(filters)(event)).to.be.false
    })

    it('returns true if event matches filter', () => {
      const filters: SubscriptionFilter[] = [{ ids: ['aa'] }]
      const event: Event = { id: 'aa' } as any

      expect((SubscribeMessageHandler as any).isClientSubscribedToEvent(filters)(event)).to.be.true
    })
  })

  describe('#canSubscribe', () => {
    it('returns undefined if subscription & filter count are allowed', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 1,
              maxFilters: 1,
            },
          },
        },
      })

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.be.undefined
    })

    it('returns undefined if max subscription limit is disabled', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 0,
            },
          },
        },
      })

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.be.undefined
    })

    it('returns undefined if filters limit is disabled', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxFilters: 0,
            },
          },
        },
      })
      filters = [{}]

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.be.undefined
    })

    it('returns reason if client is sending a duplicate subscription', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 1,
            },
          },
        },
      })
      filters = [{ authors: ['aa'] }]
      subscriptions.set(subscriptionId, filters)

      expect((handler as any).canSubscribe(subscriptionId, filters))
        .to.equal('Duplicate subscription subscriptionId: Ignoring')
    })

    it('returns reason if client subscriptions exceed limits', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxSubscriptions: 1,
            },
          },
        },
      })
      subscriptions.set('other-sub', [])

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.equal('Too many subscriptions: Number of subscriptions must be less than or equal to 1')
    })

    it('returns reason if filter count exceeds limit', () => {
      settingsFactory.returns({
        limits: {
          client: {
            subscription: {
              maxFilters: 1,
            },
          },
        },
      })
      filters = [
        {}, {},
      ]

      expect((handler as any).canSubscribe(subscriptionId, filters)).to.equal('Too many filters: Number of filters per susbscription must be less then or equal to 1')
    })
  })
})
