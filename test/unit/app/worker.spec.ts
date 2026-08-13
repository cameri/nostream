import EventEmitter from 'events'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { AppWorker } from '../../../src/app/worker'
import * as settingsUtils from '../../../src/utils/settings'

chai.use(sinonChai)

const { expect } = chai

describe('AppWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let worker: AppWorker
  let fakeProcess: EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string> }
  let fakeAdapter: any
  let watchSettingsStub: Sinon.SinonStub

  let savedEnv: { PORT: string | undefined; RELAY_PORT: string | undefined }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    savedEnv = { PORT: process.env.PORT, RELAY_PORT: process.env.RELAY_PORT }

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
      env: process.env,
    }) as EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string> }

    const fakeWatcher = {
      close: sandbox.stub(),
    } as any

    watchSettingsStub = sandbox.stub(settingsUtils.SettingsStatic, 'watchSettings').returns([fakeWatcher] as any)

    fakeAdapter = {
      listen: sandbox.stub(),
      emit: sandbox.stub(),
      close: sandbox.stub().callsFake((callback: Function) => {
        if (typeof callback === 'function') {
          callback()
        }
      }),
    }

    worker = new AppWorker(fakeProcess as any, fakeAdapter)
  })

  afterEach(() => {
    if (savedEnv.PORT === undefined) delete process.env.PORT
    else process.env.PORT = savedEnv.PORT
    if (savedEnv.RELAY_PORT === undefined) delete process.env.RELAY_PORT
    else process.env.RELAY_PORT = savedEnv.RELAY_PORT
    sandbox.restore()
  })

  describe('constructor', () => {
    it('registers SIGINT, SIGHUP, and SIGTERM handlers', () => {
      expect(fakeProcess.listenerCount('SIGINT')).to.equal(1)
      expect(fakeProcess.listenerCount('SIGHUP')).to.equal(1)
      expect(fakeProcess.listenerCount('SIGTERM')).to.equal(1)
    })

    it('registers uncaughtException and unhandledRejection handlers', () => {
      expect(fakeProcess.listenerCount('uncaughtException')).to.equal(1)
      expect(fakeProcess.listenerCount('unhandledRejection')).to.equal(1)
    })

    it('registers message handler', () => {
      expect(fakeProcess.listenerCount('message')).to.equal(1)
    })
  })

  describe('run', () => {
    beforeEach(() => {
      fakeAdapter.listen.resetHistory()
      watchSettingsStub.resetHistory()
    })

    it('watches settings on startup', () => {
      delete process.env.PORT
      delete process.env.RELAY_PORT
      worker.run()

      expect(watchSettingsStub).to.have.been.calledOnce
    })

    it('listens on default port 8008 when PORT and RELAY_PORT env vars are not set', () => {
      delete process.env.PORT
      delete process.env.RELAY_PORT
      worker.run()

      expect(fakeAdapter.listen).to.have.been.calledOnceWith(8008)
    })

    it('uses PORT env var if set', () => {
      delete process.env.RELAY_PORT
      process.env.PORT = '9000'
      worker.run()

      expect(fakeAdapter.listen).to.have.been.calledOnceWith(9000)
    })

    it('uses RELAY_PORT env var as fallback', () => {
      delete process.env.PORT
      process.env.RELAY_PORT = '9001'
      worker.run()

      expect(fakeAdapter.listen).to.have.been.calledOnceWith(9001)
    })

    it('prefers PORT over RELAY_PORT', () => {
      process.env.PORT = '9000'
      process.env.RELAY_PORT = '9001'
      worker.run()

      expect(fakeAdapter.listen).to.have.been.calledOnceWith(9000)
    })

    it('converts string port to number', () => {
      delete process.env.PORT
      process.env.RELAY_PORT = '3000'
      worker.run()

      expect(fakeAdapter.listen).to.have.been.calledOnceWith(3000)
    })
  })

  describe('onMessage', () => {
    it('emits the eventName and event to the adapter', () => {
      const message = { eventName: 'test_event', event: { id: '123' } }

      fakeProcess.emit('message', message)

      expect(fakeAdapter.emit).to.have.been.calledOnceWith('test_event', { id: '123' })
    })

    it('handles multiple messages', () => {
      fakeProcess.emit('message', { eventName: 'event1', event: { data: 'first' } })
      fakeProcess.emit('message', { eventName: 'event2', event: { data: 'second' } })

      expect(fakeAdapter.emit).to.have.been.calledTwice
      expect(fakeAdapter.emit.firstCall).to.have.been.calledWith('event1', { data: 'first' })
      expect(fakeAdapter.emit.secondCall).to.have.been.calledWith('event2', { data: 'second' })
    })
  })

  describe('onError', () => {
    it('handles TypeError about database connection without throwing', () => {
      const error = new TypeError("Cannot read properties of undefined (reading '__knexUid')")

      expect(() => fakeProcess.emit('uncaughtException', error)).not.to.throw()
    })

    it('logs other errors without throwing', () => {
      const error = new Error('test error')

      expect(() => fakeProcess.emit('uncaughtException', error)).not.to.throw()
    })
  })

  describe('onExit', () => {
    it('closes the worker on SIGTERM', () => {
      fakeProcess.emit('SIGTERM')

      expect(fakeAdapter.close).to.have.been.called
    })

    it('handles SIGINT', () => {
      fakeProcess.emit('SIGINT')

      expect(fakeAdapter.close).to.have.been.called
    })

    it('handles SIGHUP', () => {
      fakeProcess.emit('SIGHUP')

      expect(fakeAdapter.close).to.have.been.called
    })

    it('calls process.exit in the close callback', (done) => {
      fakeAdapter.close.callsFake((callback: Function) => {
        callback()
      })

      fakeProcess.emit('SIGTERM')

      setImmediate(() => {
        expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
        done()
      })
    })
  })

  describe('close', () => {
    it('closes the adapter', () => {
      worker.close()

      expect(fakeAdapter.close).to.have.been.calledOnce
    })

    it('invokes the callback when adapter is closed', (done) => {
      const callback = sandbox.stub()

      fakeAdapter.close.callsFake((cb: Function) => {
        cb()
      })

      worker.close(callback)

      setImmediate(() => {
        expect(callback).to.have.been.calledOnce
        done()
      })
    })

    it('does not throw when called without a callback', () => {
      expect(() => worker.close()).not.to.throw()
    })

    it('closes watchers when present', () => {
      const fakeWatcher1 = { close: sandbox.stub() } as any
      const fakeWatcher2 = { close: sandbox.stub() } as any
      watchSettingsStub.returns([fakeWatcher1, fakeWatcher2] as any)

      worker.run()
      worker.close()

      expect(fakeAdapter.close).to.have.been.called
      expect(fakeWatcher1.close).to.have.been.called
      expect(fakeWatcher2.close).to.have.been.called
    })

    it('handles no watchers gracefully', () => {
      watchSettingsStub.returns(undefined as any)

      worker.close()

      expect(fakeAdapter.close).to.have.been.calledOnce
    })
  })
})
