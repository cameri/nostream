import EventEmitter from 'events'
import { WebSocket } from 'ws'

import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../../../src/constants/adapter'
import { IWebSocketServerAdapter } from '../../../src/@types/adapters'
import { WebSocketAdapter } from '../../../src/adapters/web-socket-adapter'

describe('WebSocketAdapter', () => {
  let sandbox: Sinon.SinonSandbox
  let client: any
  let request: any
  let webSocketServer: any
  let createMessageHandler: Sinon.SinonStub
  let slidingWindowRateLimiter: Sinon.SinonStub
  let settingsFactory: Sinon.SinonStub
  let adapter: WebSocketAdapter

  let originalConsoleError: typeof console.error

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    originalConsoleError = console.error
    console.error = () => undefined

    client = {
      on: sandbox.stub().returnsThis(),
      send: sandbox.stub(),
      close: sandbox.stub(),
      ping: sandbox.stub(),
      pong: sandbox.stub(),
      readyState: WebSocket.OPEN,
      removeAllListeners: sandbox.stub(),
    }

    request = {
      headers: {
        'sec-websocket-key': Buffer.from('test-key-123', 'utf8').toString('base64'),
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
    }

    webSocketServer = new EventEmitter() as IWebSocketServerAdapter

    createMessageHandler = sandbox.stub()
    slidingWindowRateLimiter = sandbox.stub().returns({
      hit: sandbox.stub().resolves(false),
    })
    settingsFactory = sandbox.stub().returns({
      network: {
        remoteIpHeader: '',
      },
      limits: {
        message: {
          rateLimits: [],
          ipWhitelist: [],
        },
      },
    })

    adapter = new WebSocketAdapter(
      client,
      request,
      webSocketServer as any,
      createMessageHandler,
      slidingWindowRateLimiter,
      settingsFactory,
    )
  })

  afterEach(() => {
    console.error = originalConsoleError
    adapter.removeAllListeners()
    webSocketServer.removeAllListeners()
    sandbox.restore()
  })

  describe('constructor', () => {
    it('extracts clientId from sec-websocket-key header', () => {
      const expectedId = Buffer.from(Buffer.from('test-key-123', 'utf8').toString('base64'), 'base64').toString('hex')

      expect(adapter.getClientId()).to.equal(expectedId)
    })

    it('resolves client address from request', () => {
      expect(adapter.getClientAddress()).to.equal('127.0.0.1')
    })

    it('registers WebSocket event listeners', () => {
      expect(client.on).to.have.been.calledWith('error')
      expect(client.on).to.have.been.calledWith('message')
      expect(client.on).to.have.been.calledWith('close')
      expect(client.on).to.have.been.calledWith('pong')
      expect(client.on).to.have.been.calledWith('ping')
    })

    it('registers internal event listeners', () => {
      expect(adapter.listenerCount(WebSocketAdapterEvent.Heartbeat)).to.be.greaterThan(0)
      expect(adapter.listenerCount(WebSocketAdapterEvent.Subscribe)).to.be.greaterThan(0)
      expect(adapter.listenerCount(WebSocketAdapterEvent.Unsubscribe)).to.be.greaterThan(0)
      expect(adapter.listenerCount(WebSocketAdapterEvent.Event)).to.be.greaterThan(0)
      expect(adapter.listenerCount(WebSocketAdapterEvent.Broadcast)).to.be.greaterThan(0)
      expect(adapter.listenerCount(WebSocketAdapterEvent.Message)).to.be.greaterThan(0)
    })
  })

  describe('getClientId', () => {
    it('returns the client ID', () => {
      expect(adapter.getClientId()).to.be.a('string')
      expect(adapter.getClientId().length).to.be.greaterThan(0)
    })
  })

  describe('getClientAddress', () => {
    it('returns the client IP address', () => {
      expect(adapter.getClientAddress()).to.equal('127.0.0.1')
    })
  })

  describe('getSubscriptions', () => {
    it('returns an empty map when no subscriptions', () => {
      const subs = adapter.getSubscriptions()

      expect(subs).to.be.instanceOf(Map)
      expect(subs.size).to.equal(0)
    })

    it('returns a copy of subscriptions map', () => {
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])

      const subs = adapter.getSubscriptions()

      expect(subs.size).to.equal(1)
      expect(subs.get('sub-1')).to.deep.equal([{ kinds: [1] }])
    })
  })

  describe('onSubscribed', () => {
    it('adds subscription to the map', () => {
      const filters = [{ kinds: [1] }, { authors: ['abc'] }]

      adapter.onSubscribed('sub-1', filters)

      const subs = adapter.getSubscriptions()
      expect(subs.get('sub-1')).to.deep.equal(filters)
    })

    it('overwrites existing subscription with same id', () => {
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])
      adapter.onSubscribed('sub-1', [{ kinds: [2] }])

      const subs = adapter.getSubscriptions()
      expect(subs.size).to.equal(1)
      expect(subs.get('sub-1')).to.deep.equal([{ kinds: [2] }])
    })
  })

  describe('onUnsubscribed', () => {
    it('removes subscription from the map', () => {
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])
      adapter.onUnsubscribed('sub-1')

      const subs = adapter.getSubscriptions()
      expect(subs.size).to.equal(0)
    })

    it('does not throw when removing non-existent subscription', () => {
      expect(() => adapter.onUnsubscribed('non-existent')).not.to.throw()
    })
  })

  describe('onBroadcast', () => {
    it('emits broadcast event on the WebSocket server adapter', () => {
      const emitSpy = sandbox.spy(webSocketServer, 'emit')
      const event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        kind: 1,
        content: 'test',
        created_at: 1000000,
        sig: 'c'.repeat(128),
        tags: [],
      }

      adapter.onBroadcast(event)

      expect(emitSpy).to.have.been.calledWith(WebSocketServerAdapterEvent.Broadcast, event)
    })
  })

  describe('onHeartbeat', () => {
    it('pings the client and sets alive to false', () => {
      // Adapter starts with alive = true
      adapter.emit(WebSocketAdapterEvent.Heartbeat)

      expect(client.ping).to.have.been.calledOnce
    })

    it('closes connection when client is not alive and has no subscriptions', () => {
      // First heartbeat: sets alive to false, pings
      adapter.emit(WebSocketAdapterEvent.Heartbeat)
      // Second heartbeat: alive is false, no subs -> close
      adapter.emit(WebSocketAdapterEvent.Heartbeat)

      expect(client.close).to.have.been.calledOnce
    })

    it('closes when client is not alive even if it has active subscriptions', () => {
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])

      // First heartbeat: sets alive to false, pings
      adapter.emit(WebSocketAdapterEvent.Heartbeat)
      // Second heartbeat: alive is still false, has subs -> still close
      adapter.emit(WebSocketAdapterEvent.Heartbeat)

      expect(client.close).to.have.been.called
    })
  })

  describe('sendMessage (via Message event)', () => {
    it('sends JSON-serialized message when WebSocket is OPEN', () => {
      client.readyState = WebSocket.OPEN
      const message = ['NOTICE', 'hello']

      adapter.emit(WebSocketAdapterEvent.Message, message)

      expect(client.send).to.have.been.calledOnceWithExactly(JSON.stringify(message))
    })

    it('does nothing when WebSocket is not OPEN', () => {
      client.readyState = WebSocket.CLOSED
      const message = ['NOTICE', 'hello']

      adapter.emit(WebSocketAdapterEvent.Message, message)

      expect(client.send).not.to.have.been.called
    })
  })

  describe('onSendEvent (via Event event)', () => {
    it('sends event matching subscription filters', () => {
      client.readyState = WebSocket.OPEN
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])

      const event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        kind: 1,
        content: 'hello',
        created_at: 1000000,
        sig: 'c'.repeat(128),
        tags: [],
      }

      adapter.emit(WebSocketAdapterEvent.Event, event)

      expect(client.send).to.have.been.calledOnce
      const sent = JSON.parse(client.send.firstCall.args[0])
      expect(sent[0]).to.equal('EVENT')
      expect(sent[1]).to.equal('sub-1')
      expect(sent[2]).to.deep.equal(event)
    })

    it('does not send event not matching any filter', () => {
      client.readyState = WebSocket.OPEN
      adapter.onSubscribed('sub-1', [{ kinds: [999] }])

      const event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        kind: 1,
        content: 'hello',
        created_at: 1000000,
        sig: 'c'.repeat(128),
        tags: [],
      }

      adapter.emit(WebSocketAdapterEvent.Event, event)

      expect(client.send).not.to.have.been.called
    })
  })

  describe('onClientClose', () => {
    it('clears all subscriptions when client disconnects', () => {
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])
      adapter.onSubscribed('sub-2', [{ kinds: [2] }])

      // Trigger the close handler
      const closeCall = client.on.getCalls().find((call: any) => call.args[0] === 'close')
      const onClose = closeCall.args[1]
      onClose()

      expect(adapter.getSubscriptions().size).to.equal(0)
    })

    it('removes all listeners from client', () => {
      const closeCall = client.on.getCalls().find((call: any) => call.args[0] === 'close')
      const onClose = closeCall.args[1]
      onClose()

      expect(client.removeAllListeners).to.have.been.calledOnce
    })
  })

  describe('onClientPong', () => {
    it('marks client as alive', () => {
      // First heartbeat sets alive = false
      adapter.emit(WebSocketAdapterEvent.Heartbeat)

      // Trigger pong handler - should set alive = true
      const pongCall = client.on.getCalls().find((call: any) => call.args[0] === 'pong')
      const onPong = pongCall.args[1]
      onPong()

      // Next heartbeat should not close (alive was reset to true)
      adapter.emit(WebSocketAdapterEvent.Heartbeat)

      expect(client.close).not.to.have.been.called
    })
  })

  describe('onClientPing', () => {
    it('responds with pong', () => {
      const pingCall = client.on.getCalls().find((call: any) => call.args[0] === 'ping')
      const onPing = pingCall.args[1]
      const data = Buffer.from('ping-data')

      onPing(data)

      expect(client.pong).to.have.been.calledOnceWithExactly(data)
    })
  })

  describe('error handling', () => {
    it('closes client on RangeError with max payload exceeded', () => {
      const errorCall = client.on.getCalls().find((call: any) => call.args[0] === 'error')
      const onError = errorCall.args[1]

      const error = new RangeError('Max payload size exceeded')

      onError(error)

      expect(client.close).to.have.been.calledOnce
    })

    it('closes client on RSV1 compression error', () => {
      const errorCall = client.on.getCalls().find((call: any) => call.args[0] === 'error')
      const onError = errorCall.args[1]

      const error = new RangeError('Invalid WebSocket frame: RSV1 must be clear')

      onError(error)

      expect(client.close).to.have.been.calledOnce
    })

    it('closes client on generic errors', () => {
      const errorCall = client.on.getCalls().find((call: any) => call.args[0] === 'error')
      const onError = errorCall.args[1]

      const error = new Error('something went wrong')

      onError(error)

      expect(client.close).to.have.been.calledOnce
    })
  })

  describe('onClientMessage', () => {
    it('handles invalid JSON gracefully', async () => {
      client.readyState = WebSocket.OPEN

      const messageCall = client.on.getCalls().find((call: any) => call.args[0] === 'message')
      const onMessage = messageCall.args[1]

      await onMessage(Buffer.from('not-json'))

      // Should send a NOTICE about invalid message
      expect(client.send).to.have.been.calledOnce
      const sent = JSON.parse(client.send.firstCall.args[0])
      expect(sent[0]).to.equal('NOTICE')
    })

    it('sends rate-limited notice when rate limited', async () => {
      client.readyState = WebSocket.OPEN

      // Configure rate limiting to be active
      settingsFactory.returns({
        network: { remoteIpHeader: '' },
        limits: {
          message: {
            rateLimits: [{ period: 60000, rate: 1 }],
            ipWhitelist: [],
          },
        },
      })

      slidingWindowRateLimiter.returns({
        hit: sandbox.stub().resolves(true),
      })

      const messageCall = client.on.getCalls().find((call: any) => call.args[0] === 'message')
      const onMessage = messageCall.args[1]

      // Valid JSON message that would pass parsing
      await onMessage(Buffer.from(JSON.stringify(['EVENT', {}])))

      expect(client.send).to.have.been.called
    })

    it('does not rate limit when no rateLimits are configured', async () => {
      client.readyState = WebSocket.OPEN

      settingsFactory.returns({
        network: { remoteIpHeader: '' },
        limits: {
          message: {},
        },
      })

      const messageCall = client.on.getCalls().find((call: any) => call.args[0] === 'message')
      const onMessage = messageCall.args[1]

      // Invalid JSON will cause a parsing NOTICE, not a rate-limit NOTICE
      await onMessage(Buffer.from('invalid'))

      expect(client.send).to.have.been.calledOnce
      const sent = JSON.parse(client.send.firstCall.args[0])
      expect(sent[0]).to.equal('NOTICE')
      expect(sent[1]).not.to.include('rate limited')
    })

    it('does not rate limit when client IP is whitelisted', async () => {
      client.readyState = WebSocket.OPEN

      settingsFactory.returns({
        network: { remoteIpHeader: '' },
        limits: {
          message: {
            rateLimits: [{ period: 60000, rate: 0 }],
            ipWhitelist: ['127.0.0.1'],
          },
        },
      })

      const messageCall = client.on.getCalls().find((call: any) => call.args[0] === 'message')
      const onMessage = messageCall.args[1]

      await onMessage(Buffer.from('invalid'))

      // Should get a parsing error NOTICE, not a rate-limit NOTICE
      expect(client.send).to.have.been.calledOnce
      const sent = JSON.parse(client.send.firstCall.args[0])
      expect(sent[1]).not.to.include('rate limited')
    })

    it('sets alive to true when message is received', async () => {
      // First heartbeat sets alive = false
      adapter.emit(WebSocketAdapterEvent.Heartbeat)

      const messageCall = client.on.getCalls().find((call: any) => call.args[0] === 'message')
      const onMessage = messageCall.args[1]

      // Receiving any message sets alive = true
      await onMessage(Buffer.from('invalid'))

      // Next heartbeat should NOT close (alive was reset by message)
      adapter.emit(WebSocketAdapterEvent.Heartbeat)

      expect(client.close).not.to.have.been.called
    })

    it('handles AbortError without sending notice', async () => {
      client.readyState = WebSocket.OPEN

      settingsFactory.returns({
        network: { remoteIpHeader: '' },
        limits: { message: {} },
      })

      const abortError = new Error('aborted')
      abortError.name = 'AbortError'

      createMessageHandler.returns({
        handleMessage: sandbox.stub().rejects(abortError),
      })

      const messageCall = client.on.getCalls().find((call: any) => call.args[0] === 'message')
      const onMessage = messageCall.args[1]

      await onMessage(Buffer.from(JSON.stringify(['REQ', 'sub-1', {}])))

      // AbortError should NOT send a NOTICE to client
      expect(client.send).not.to.have.been.called
    })

    it('returns early when no handler is found for message', async () => {
      client.readyState = WebSocket.OPEN

      settingsFactory.returns({
        network: { remoteIpHeader: '' },
        limits: { message: {} },
      })

      createMessageHandler.returns(null)

      const messageCall = client.on.getCalls().find((call: any) => call.args[0] === 'message')
      const onMessage = messageCall.args[1]

      // Should not throw and should not send any message
      await onMessage(Buffer.from(JSON.stringify(['REQ', 'sub-1', {}])))

      expect(client.send).not.to.have.been.called
    })
  })

  describe('onSendEvent edge cases', () => {
    it('sends event to multiple matching subscriptions', () => {
      client.readyState = WebSocket.OPEN
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])
      adapter.onSubscribed('sub-2', [{ kinds: [1] }])

      const event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        kind: 1,
        content: 'hello',
        created_at: 1000000,
        sig: 'c'.repeat(128),
        tags: [],
      }

      adapter.emit(WebSocketAdapterEvent.Event, event)

      expect(client.send).to.have.been.calledTwice
    })

    it('does not send when socket is not OPEN', () => {
      client.readyState = WebSocket.CLOSED
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])

      const event = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        kind: 1,
        content: 'hello',
        created_at: 1000000,
        sig: 'c'.repeat(128),
        tags: [],
      }

      adapter.emit(WebSocketAdapterEvent.Event, event)

      expect(client.send).not.to.have.been.called
    })
  })

  describe('getSubscriptions edge cases', () => {
    it('returns a copy that does not affect internal state', () => {
      adapter.onSubscribed('sub-1', [{ kinds: [1] }])

      const subs = adapter.getSubscriptions()
      subs.delete('sub-1')

      // Internal state should not be affected
      expect(adapter.getSubscriptions().size).to.equal(1)
    })
  })

  describe('IPv6 support', () => {
    it('handles IPv6 client address', () => {
      const ipv6Request = {
        headers: {
          'sec-websocket-key': Buffer.from('ipv6-key', 'utf8').toString('base64'),
        },
        socket: {
          remoteAddress: '::1',
        },
      }

      const ipv6Adapter = new WebSocketAdapter(
        client,
        ipv6Request as any,
        webSocketServer as any,
        createMessageHandler,
        slidingWindowRateLimiter,
        settingsFactory,
      )

      expect(ipv6Adapter.getClientAddress()).to.equal('::1')
      ipv6Adapter.removeAllListeners()
    })
  })
})
