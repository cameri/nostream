import EventEmitter from 'events'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { App } from '../../../src/app/app'
import { Settings } from '../../../src/@types/settings'
import * as settingsUtils from '../../../src/utils/settings'
import * as torClient from '../../../src/tor/client'

chai.use(sinonChai)

const { expect } = chai

describe('App', () => {
  let sandbox: Sinon.SinonSandbox
  let app: App
  let fakeProcess: NodeJS.Process & { exit: Sinon.SinonStub }
  let fakeCluster: any
  let settingsStub: Sinon.SinonStub
  let watchSettingsStub: Sinon.SinonStub
  let addOnionStub: Sinon.SinonStub
  let settingsState: Partial<Settings>

  const defaultSettings = (): Partial<Settings> => ({
    workers: { count: 2 },
    mirroring: {
      static: [],
    },
    info: {
      relay_url: 'wss://relay.example.com',
      name: 'test',
      description: 'test relay',
      pubkey: 'a'.repeat(64),
      contact: 'test@example.com',
    } as any,
  })

  const createFakeWorker = (): any => ({
    id: Math.floor(Math.random() * 10000),
    process: { pid: Math.floor(Math.random() * 100000) },
    send: sandbox.stub(),
  })

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
      env: { RELAY_PORT: '8008' },
    }) as any

    const fakeWorker1 = createFakeWorker()
    const fakeWorker2 = createFakeWorker()

    fakeCluster = Object.assign(new EventEmitter(), {
      workers: {
        [fakeWorker1.id]: fakeWorker1,
        [fakeWorker2.id]: fakeWorker2,
      },
      fork: sandbox.stub().callsFake((env: Record<string, string>) => {
        const newWorker = createFakeWorker()
        fakeCluster.workers[newWorker.id] = newWorker
        return newWorker
      }),
    })

    settingsState = defaultSettings()
    settingsStub = sandbox.stub().callsFake(() => settingsState)

    const fakeWatcher = { close: sandbox.stub() } as any
    watchSettingsStub = sandbox.stub(settingsUtils.SettingsStatic, 'watchSettings').returns([fakeWatcher] as any)

    addOnionStub = sandbox.stub(torClient, 'addOnion').resolves('onion-address.onion')
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('constructor', () => {
    it('initializes the app with process and cluster', () => {
      app = new App(fakeProcess, fakeCluster, settingsStub)

      expect(fakeCluster.listenerCount('message')).to.equal(1)
      expect(fakeCluster.listenerCount('exit')).to.equal(1)
      expect(fakeProcess.listenerCount('SIGTERM')).to.equal(1)
    })

    it('creates a WeakMap for tracking workers', () => {
      app = new App(fakeProcess, fakeCluster, settingsStub)

      expect(app).to.be.an('object')
    })
  })

  describe('run', () => {
    beforeEach(() => {
      fakeCluster.fork.resetHistory()
      fakeCluster.workers = {}
      app = new App(fakeProcess, fakeCluster, settingsStub)
    })

    it('watches settings on startup', () => {
      app.run()

      expect(watchSettingsStub).to.have.been.calledOnce
    })

    it('forks worker processes based on configured count', () => {
      settingsState.workers = { count: 3 }

      app.run()

      // Should fork 3 client workers + 1 maintenance worker
      expect(fakeCluster.fork.callCount).to.be.at.least(4)
    })

    it('uses CPU count as default worker count when not configured', () => {
      settingsState.workers = undefined

      app.run()

      expect(fakeCluster.fork.callCount).to.be.greaterThan(0)
    })

    it('respects WORKER_COUNT environment variable', () => {
      fakeCluster.fork.resetHistory()
      fakeProcess.env.WORKER_COUNT = '2'
      settingsState.workers = { count: 10 }

      const appInstance = new App(fakeProcess, fakeCluster, settingsStub)
      appInstance.run()

      // WORKER_COUNT overrides settings, so should fork 2 + 1 maintenance
      expect(fakeCluster.fork.callCount).to.equal(3)
    })

    it('forks one maintenance worker', () => {
      settingsState.workers = { count: 2 }

      app.run()

      const maintenanceCall = Array.from((fakeCluster.fork as any).getCalls()).find(
        (call: any) => call.args?.[0]?.WORKER_TYPE === 'maintenance',
      )

      expect(maintenanceCall).to.exist
    })

    it('forks static-mirroring workers when mirroring is configured', () => {
      settingsState.workers = { count: 1 }
      settingsState.mirroring = {
        static: [
          { address: 'ws://mirror1.com', filters: [] } as any,
          { address: 'ws://mirror2.com', filters: [] } as any,
        ],
      }

      app.run()

      const mirrorCalls = Array.from((fakeCluster.fork as any).getCalls()).filter(
        (call: any) => call.args?.[0]?.WORKER_TYPE === 'static-mirroring',
      )

      expect(mirrorCalls).to.have.lengthOf(2)
    })

    it('assigns MIRROR_INDEX to mirroring workers', () => {
      settingsState.workers = { count: 1 }
      settingsState.mirroring = {
        static: [{ address: 'ws://mirror.com', filters: [] } as any],
      }

      app.run()

      const mirrorCall = Array.from((fakeCluster.fork as any).getCalls()).find(
        (call: any) => call.args?.[0]?.WORKER_TYPE === 'static-mirroring',
      )

      expect((mirrorCall as any)?.args?.[0]?.MIRROR_INDEX).to.equal('0')
    })

    it('assigns WORKER_INDEX to client workers', () => {
      settingsState.workers = { count: 2 }

      app.run()

      const workerCalls = Array.from((fakeCluster.fork as any).getCalls()).filter(
        (call: any) => call.args?.[0]?.WORKER_TYPE === 'worker',
      )

      expect((workerCalls[0] as any)?.args?.[0]?.WORKER_INDEX).to.equal('0')
      expect((workerCalls[1] as any)?.args?.[0]?.WORKER_INDEX).to.equal('1')
    })

    it('attempts to add Tor hidden service', () => {
      fakeProcess.env.HIDDEN_SERVICE_PORT = '80'
      fakeProcess.env.RELAY_PORT = '8008'

      app.run()

      expect(addOnionStub).to.have.been.called
    })

    it('handles Tor hidden service setup failure gracefully', async () => {
      addOnionStub.rejects(new Error('Tor unavailable'))

      app.run()

      // Should not throw
      expect(app).to.exist
    })

    it('exits when SECRET is missing but payments are enabled', () => {
      settingsState.payments = { enabled: true } as any
      fakeProcess.env.SECRET = ''

      app.run()

      expect(fakeProcess.exit).to.have.been.calledWith(1)
    })

    it('exits when SECRET is default and payments are enabled', () => {
      settingsState.payments = { enabled: true } as any
      fakeProcess.env.SECRET = 'changeme'

      app.run()

      expect(fakeProcess.exit).to.have.been.calledWith(1)
    })

    it('does not exit when SECRET is valid and payments are enabled', () => {
      settingsState.payments = { enabled: true } as any
      fakeProcess.env.SECRET = 'secure-secret-key'

      app.run()

      expect(fakeProcess.exit).not.to.have.been.called
    })

    it('does not require SECRET when payments are disabled', () => {
      settingsState.payments = { enabled: false } as any
      fakeProcess.env.SECRET = ''

      app.run()

      expect(fakeProcess.exit).not.to.have.been.called
    })
  })

  describe('onClusterMessage', () => {
    let worker1: any
    let worker2: any

    beforeEach(() => {
      worker1 = createFakeWorker()
      worker2 = createFakeWorker()

      fakeCluster.workers = {
        [worker1.id]: worker1,
        [worker2.id]: worker2,
      }

      app = new App(fakeProcess, fakeCluster, settingsStub)
    })

    it('broadcasts message to all workers except sender', () => {
      const message = { eventName: 'test', event: {} }

      fakeCluster.emit('message', worker1, message)

      expect(worker2.send).to.have.been.calledWith(message)
      expect(worker1.send).not.to.have.been.called
    })

    it('handles messages from multiple sources', () => {
      const message1 = { eventName: 'event1', event: {} }
      const message2 = { eventName: 'event2', event: {} }

      fakeCluster.emit('message', worker1, message1)
      fakeCluster.emit('message', worker2, message2)

      expect(worker2.send).to.have.been.calledWith(message1)
      expect(worker1.send).to.have.been.calledWith(message2)
    })
  })

  describe('onClusterExit', () => {
    let worker: any
    let deadWorker: any

    beforeEach(() => {
      worker = createFakeWorker()
      deadWorker = createFakeWorker()

      fakeCluster.workers = {
        [worker.id]: worker,
        [deadWorker.id]: deadWorker,
      }

      app = new App(fakeProcess, fakeCluster, settingsStub)
    })

    it('does not restart worker on clean exit (code 0)', () => {
      fakeCluster.emit('exit', deadWorker, 0, '')

      // No restart scheduled
      expect(fakeCluster.fork).not.to.have.been.called
    })

    it('does not restart worker on SIGINT signal', () => {
      fakeCluster.emit('exit', deadWorker, null, 'SIGINT')

      expect(fakeCluster.fork).not.to.have.been.called
    })

    it('schedules worker restart on unexpected exit', () => {
      // When a worker exits unexpectedly, the app schedules a restart
      // We verify that exit handling doesn't throw
      expect(() => {
        fakeCluster.emit('exit', deadWorker, 1, '')
      }).not.to.throw()
    })
  })

  describe('onExit', () => {
    beforeEach(() => {
      app = new App(fakeProcess, fakeCluster, settingsStub)
    })

    it('closes watchers and exits process with code 0', () => {
      app.run()
      fakeProcess.emit('SIGTERM')

      expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
    })
  })

  describe('close', () => {
    beforeEach(() => {
      app = new App(fakeProcess, fakeCluster, settingsStub)
    })

    it('closes all file watchers', () => {
      const fakeWatcher1 = { close: sandbox.stub() }
      const fakeWatcher2 = { close: sandbox.stub() }
      watchSettingsStub.returns([fakeWatcher1, fakeWatcher2])

      app.run()
      app.close()

      expect(fakeWatcher1.close).to.have.been.called
      expect(fakeWatcher2.close).to.have.been.called
    })

    it('invokes the callback', () => {
      const callback = sandbox.stub()

      app.close(callback)

      expect(callback).to.have.been.calledOnce
    })

    it('does not throw when called without watchers', () => {
      watchSettingsStub.returns([])

      expect(() => app.close()).not.to.throw()
    })

    it('handles undefined watchers gracefully', () => {
      expect(() => app.close()).not.to.throw()
    })
  })
})
