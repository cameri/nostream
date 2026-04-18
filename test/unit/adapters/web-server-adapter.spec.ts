import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)

const { expect } = chai

import { WebServerAdapter } from '../../../src/adapters/web-server-adapter'

describe('WebServerAdapter', () => {
  let sandbox: Sinon.SinonSandbox
  let webServer: any
  let adapter: WebServerAdapter

  let originalConsoleError: typeof console.error

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    originalConsoleError = console.error
    console.error = () => undefined

    webServer = {
      on: sandbox.stub().returnsThis(),
      once: sandbox.stub().returnsThis(),
      listen: sandbox.stub(),
      close: sandbox.stub(),
      removeAllListeners: sandbox.stub(),
    }

    adapter = new WebServerAdapter(webServer)
  })

  afterEach(() => {
    console.error = originalConsoleError
    sandbox.restore()
    adapter.removeAllListeners()
  })

  describe('constructor', () => {
    it('registers error event listener on webServer', () => {
      expect(webServer.on).to.have.been.calledWith('error')
    })

    it('registers clientError event listener on webServer', () => {
      expect(webServer.on).to.have.been.calledWith('clientError')
    })

    it('registers close event listener on webServer', () => {
      expect(webServer.once).to.have.been.calledWith('close')
    })

    it('registers listening event listener on webServer', () => {
      expect(webServer.once).to.have.been.calledWith('listening')
    })
  })

  describe('listen', () => {
    it('calls webServer.listen with the given port', () => {
      adapter.listen(8080)

      expect(webServer.listen).to.have.been.calledOnceWithExactly(8080)
    })
  })

  describe('close', () => {
    it('calls webServer.close', () => {
      adapter.close()

      expect(webServer.close).to.have.been.calledOnce
    })

    it('invokes callback after close completes', () => {
      const callback = sandbox.stub()
      webServer.close.callsFake((cb: () => void) => cb())

      adapter.close(callback)

      expect(callback).to.have.been.calledOnce
    })

    it('removes all listeners from webServer after close', () => {
      webServer.close.callsFake((cb: () => void) => cb())

      adapter.close()

      expect(webServer.removeAllListeners).to.have.been.calledOnce
    })

    it('does not throw if callback is undefined', () => {
      webServer.close.callsFake((cb: () => void) => cb())

      expect(() => adapter.close()).not.to.throw()
    })
  })

  describe('onClientError', () => {
    it('ignores ECONNRESET errors', () => {
      const error: any = new Error('connection reset')
      error.code = 'ECONNRESET'
      const socket: any = { writable: true, end: sandbox.stub() }

      // Access private method through event handler
      // Find the clientError handler registered in constructor
      const clientErrorCall = webServer.on.getCalls().find((call: any) => call.args[0] === 'clientError')
      const handler = clientErrorCall.args[1]

      handler(error, socket)

      expect(socket.end).not.to.have.been.called
    })

    it('ignores errors when socket is not writable', () => {
      const error = new Error('some error')
      const socket: any = { writable: false, end: sandbox.stub() }

      const clientErrorCall = webServer.on.getCalls().find((call: any) => call.args[0] === 'clientError')
      const handler = clientErrorCall.args[1]

      handler(error, socket)

      expect(socket.end).not.to.have.been.called
    })

    it('sends 400 response for other client errors', () => {
      const error = new Error('bad request')
      const socket: any = { writable: true, end: sandbox.stub() }

      const clientErrorCall = webServer.on.getCalls().find((call: any) => call.args[0] === 'clientError')
      const handler = clientErrorCall.args[1]

      handler(error, socket)

      expect(socket.end).to.have.been.calledOnce
      expect(socket.end.firstCall.args[0]).to.include('400 Bad Request')
    })
  })

  describe('onError', () => {
    it('handles server errors without throwing', () => {
      const errorCall = webServer.on.getCalls().find((call: any) => call.args[0] === 'error')
      const handler = errorCall.args[1]

      expect(() => handler(new Error('server error'))).not.to.throw()
    })
  })
})
