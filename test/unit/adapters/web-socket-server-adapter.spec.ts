import * as rateLimiterMiddleware from '../../../src/handlers/request-handlers/rate-limiter-middleware'

import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)

const { expect } = chai

import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../../../src/constants/adapter'
import { WebSocketServerAdapter } from '../../../src/adapters/web-socket-server-adapter'

describe('WebSocketServerAdapter', () => {
  let sandbox: Sinon.SinonSandbox
  let webServer: any
  let webSocketServer: any
  let createWebSocketAdapter: Sinon.SinonStub
  let settings: any
  let adapter: WebSocketServerAdapter
  let isRateLimitedStub: Sinon.SinonStub

  let originalConsoleError: typeof console.error

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.useFakeTimers()
    originalConsoleError = console.error
    console.error = () => undefined

    isRateLimitedStub = sandbox.stub(rateLimiterMiddleware, 'isRateLimited').resolves(false)

    webServer = {
      on: sandbox.stub().returnsThis(),
      once: sandbox.stub().returnsThis(),
      close: sandbox.stub(),
      removeAllListeners: sandbox.stub(),
      listen: sandbox.stub(),
    }

    webSocketServer = {
      on: sandbox.stub().returnsThis(),
      clients: new Set(),
      close: sandbox.stub(),
      removeAllListeners: sandbox.stub(),
    }

    createWebSocketAdapter = sandbox.stub()

    settings = () =>
      ({
        network: {
          remoteIpHeader: '',
        },
        limits: {
          connection: {
            rateLimits: [],
          },
        },
      }) as any

    adapter = new WebSocketServerAdapter(webServer, webSocketServer, createWebSocketAdapter, settings)
  })

  afterEach(() => {
    console.error = originalConsoleError
    webServer.close.callsFake((cb: () => void) => cb())
    webSocketServer.clients = new Set()
    webSocketServer.close.callsFake((cb: () => void) => cb())
    adapter.close()
    sandbox.restore()
  })

  describe('constructor', () => {
    it('registers broadcast event listener on itself', () => {
      expect(adapter.listenerCount(WebSocketServerAdapterEvent.Broadcast)).to.be.greaterThan(0)
    })

    it('registers connection event listener on webSocketServer', () => {
      expect(webSocketServer.on).to.have.been.calledWith(WebSocketServerAdapterEvent.Connection)
    })

    it('registers error event listener on webSocketServer', () => {
      expect(webSocketServer.on).to.have.been.calledWith('error')
    })
  })

  describe('getConnectedClients', () => {
    it('returns 0 when no clients are connected', () => {
      webSocketServer.clients = new Set()

      expect(adapter.getConnectedClients()).to.equal(0)
    })

    it('counts only clients with OPEN readyState', () => {
      const OPEN = 1
      const CLOSING = 2

      webSocketServer.clients = new Set([{ readyState: OPEN }, { readyState: OPEN }, { readyState: CLOSING }] as any)

      expect(adapter.getConnectedClients()).to.equal(2)
    })
  })

  describe('close', () => {
    it('calls parent close which closes webServer', () => {
      adapter.close()

      expect(webServer.close).to.have.been.calledOnce
    })

    it('terminates all connected WebSocket clients', () => {
      const terminateStub1 = sandbox.stub()
      const terminateStub2 = sandbox.stub()

      webSocketServer.clients = new Set([{ terminate: terminateStub1 }, { terminate: terminateStub2 }] as any)

      webServer.close.callsFake((cb: () => void) => cb())
      webSocketServer.close.callsFake((cb: () => void) => cb())

      adapter.close()

      expect(terminateStub1).to.have.been.calledOnce
      expect(terminateStub2).to.have.been.calledOnce
    })

    it('closes the webSocketServer after terminating clients', () => {
      webSocketServer.clients = new Set()
      webServer.close.callsFake((cb: () => void) => cb())
      webSocketServer.close.callsFake((cb: () => void) => cb())

      adapter.close()

      expect(webSocketServer.close).to.have.been.calledOnce
    })

    it('invokes callback after full close', () => {
      const callback = sandbox.stub()
      webSocketServer.clients = new Set()
      webServer.close.callsFake((cb: () => void) => cb())
      webSocketServer.close.callsFake((cb: () => void) => cb())

      adapter.close(callback)

      expect(callback).to.have.been.calledOnce
    })

    it('removes all listeners from webSocketServer after close', () => {
      webSocketServer.clients = new Set()
      webServer.close.callsFake((cb: () => void) => cb())
      webSocketServer.close.callsFake((cb: () => void) => cb())

      adapter.close()

      expect(webSocketServer.removeAllListeners).to.have.been.calledOnce
    })
  })

  describe('onBroadcast', () => {
    it('emits event to adapters of all OPEN clients', async () => {
      const OPEN = 1
      const emitStub = sandbox.stub()

      const mockClient = { readyState: OPEN }
      webSocketServer.clients = new Set([mockClient] as any)

      const mockAdapter = {
        emit: emitStub,
        getClientId: () => 'test-id',
        getClientAddress: () => '127.0.0.1',
      }
      createWebSocketAdapter.returns(mockAdapter)

      // Populate the WeakMap by invoking onConnection
      const connectionCall = webSocketServer.on
        .getCalls()
        .find((call: any) => call.args[0] === WebSocketServerAdapterEvent.Connection)
      const onConnection = connectionCall.args[1]
      const mockReq = {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      }
      await onConnection(mockClient, mockReq)

      const event = { id: 'test', pubkey: 'test', kind: 1, content: '', created_at: 0, sig: 'test', tags: [] }
      adapter.emit(WebSocketServerAdapterEvent.Broadcast, event)

      expect(emitStub).to.have.been.calledWith(WebSocketAdapterEvent.Event, event)
    })

    it('skips clients that are not in OPEN state', () => {
      const CLOSING = 2

      const mockClient = { readyState: CLOSING }
      webSocketServer.clients = new Set([mockClient] as any)

      const event = { id: 'test', pubkey: 'test', kind: 1, content: '', created_at: 0, sig: 'test', tags: [] }

      // Should not throw when skipping non-OPEN clients
      expect(() => adapter.emit(WebSocketServerAdapterEvent.Broadcast, event)).not.to.throw()
    })
  })

  describe('onHeartbeat', () => {
    it('emits heartbeat to connected adapters on the heartbeat interval', async () => {
      const emitStub = sandbox.stub()
      const OPEN = 1

      const mockClient = { readyState: OPEN }
      webSocketServer.clients = new Set([mockClient] as any)

      const mockWsAdapter = {
        emit: emitStub,
        getClientId: () => 'test-id',
        getClientAddress: () => '127.0.0.1',
      }
      createWebSocketAdapter.returns(mockWsAdapter)

      // Populate the WeakMap via onConnection
      const connectionCall = webSocketServer.on
        .getCalls()
        .find((call: any) => call.args[0] === WebSocketServerAdapterEvent.Connection)
      const onConnection = connectionCall.args[1]
      const mockReq = {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      }
      await onConnection(mockClient, mockReq)

      // Advance past the heartbeat interval (WSS_CLIENT_HEALTH_PROBE_INTERVAL = 120000ms)
      sandbox.clock.tick(120000)

      expect(emitStub).to.have.been.calledWith(WebSocketAdapterEvent.Heartbeat)
    })
  })

  describe('onConnection', () => {
    it('creates a WebSocketAdapter for new connection', async () => {
      const mockWsAdapter = { getClientId: () => 'test-id', getClientAddress: () => '127.0.0.1' }
      createWebSocketAdapter.returns(mockWsAdapter)

      const connectionCall = webSocketServer.on
        .getCalls()
        .find((call: any) => call.args[0] === WebSocketServerAdapterEvent.Connection)
      const onConnection = connectionCall.args[1]

      const mockClient = {}
      const mockReq = {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      }

      await onConnection(mockClient, mockReq)

      expect(createWebSocketAdapter).to.have.been.calledOnce
    })

    it('terminates rate-limited connections', async () => {
      const terminateStub = sandbox.stub()
      isRateLimitedStub.resolves(true)

      const connectionCall = webSocketServer.on
        .getCalls()
        .find((call: any) => call.args[0] === WebSocketServerAdapterEvent.Connection)
      const onConnection = connectionCall.args[1]

      const mockClient = { terminate: terminateStub }
      const mockReq = {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      }

      await onConnection(mockClient, mockReq)

      expect(terminateStub).to.have.been.calledOnce
      expect(createWebSocketAdapter).not.to.have.been.called
    })
  })
})
