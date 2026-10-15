import EventEmitter from 'events'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { App } from '../../../src/app/app'
import * as metricsTelemetry from '../../../src/telemetry/metrics'
import * as operatorNotificationEnqueue from '../../../src/utils/operator-notification-enqueue'
import * as torClient from '../../../src/tor/client'
import { Settings } from '../../../src/@types/settings'
import { SettingsStatic } from '../../../src/utils/settings'

chai.use(sinonChai)

const { expect } = chai

describe('App', () => {
  let sandbox: Sinon.SinonSandbox
  let fakeProcess: EventEmitter & { exit: Sinon.SinonStub; on: Sinon.SinonStub; env: NodeJS.ProcessEnv }
  let cluster: EventEmitter & {
    on: Sinon.SinonStub
    workers: Record<string, any>
    fork: Sinon.SinonStub
  }
  let settings: Sinon.SinonStub

  const createWorker = (id: string, pid: number) => {
    const worker = new EventEmitter() as EventEmitter & {
      id: string
      process: { pid: number }
      once: Sinon.SinonStub
      kill: Sinon.SinonStub
    }

    worker.id = id
    worker.process = { pid }
    worker.once = sandbox.stub()
    worker.kill = sandbox.stub()

    return worker
  }

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.stub(metricsTelemetry, 'shutdownMetricsTelemetry').resolves()

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
      on: sandbox.stub().returnsThis(),
      env: {},
    }) as EventEmitter & { exit: Sinon.SinonStub; on: Sinon.SinonStub; env: NodeJS.ProcessEnv }

    cluster = Object.assign(new EventEmitter(), {
      on: sandbox.stub().returnsThis(),
      workers: {},
      fork: sandbox.stub(),
    }) as EventEmitter & {
      on: Sinon.SinonStub
      workers: Record<string, any>
      fork: Sinon.SinonStub
    }

    settings = sandbox.stub().returns({
      payments: { enabled: false },
      workers: { count: 1 },
    } as Settings)

    new App(fakeProcess as any, cluster as any, settings)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('forwards SIGTERM to cluster workers and exits after they stop', async () => {
    const worker = createWorker('1', 1001)
    cluster.workers = { '1': worker }

    const sigtermHandler = fakeProcess.on.getCalls().find((call) => call.args[0] === 'SIGTERM')?.args[1]
    worker.once.callsFake((_event: string, callback: () => void) => {
      callback()
    })

    sigtermHandler()
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    expect(worker.kill).to.have.been.calledOnce
    expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
  })

  it('does not respawn workers while shutting down', () => {
    const worker = createWorker('1', 1001)
    cluster.workers = { '1': worker }

    const sigtermHandler = fakeProcess.on.getCalls().find((call) => call.args[0] === 'SIGTERM')?.args[1]
    const exitHandler = cluster.on.getCalls().find((call) => call.args[0] === 'exit')?.args[1]

    sigtermHandler()
    exitHandler(worker, 1, 'SIGTERM')

    expect(cluster.fork).not.to.have.been.called
  })

  it('exits when the shutdown deadline is exceeded', async () => {
    sandbox.useFakeTimers()

    const worker = createWorker('1', 1001)
    cluster.workers = { '1': worker }

    const sigtermHandler = fakeProcess.on.getCalls().find((call) => call.args[0] === 'SIGTERM')?.args[1]
    sigtermHandler()

    await sandbox.clock.tickAsync(35_000)

    expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
  })

  it('exits before forking any worker when eventStore.backend is unsupported', () => {
    sandbox.stub(SettingsStatic, 'watchSettings').returns([])
    const app = new App(
      fakeProcess as any,
      cluster as any,
      sandbox.stub().returns({
        payments: { enabled: false },
        workers: { count: 1 },
        eventStore: { backend: 'mongodb' },
      } as unknown as Settings),
    )

    app.run()

    expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(1)
    expect(cluster.fork).not.to.have.been.called
  })

  it('hands every worker, re-forked ones included, the event store resolved at startup', async () => {
    // run() reads both from process.env
    const env = { ...process.env }
    delete env.WORKER_COUNT
    delete env.RELAY_BROADCAST_FANOUT
    sandbox.stub(process, 'env').value(env)
    sandbox.useFakeTimers()
    sandbox.stub(SettingsStatic, 'watchSettings').returns([])
    sandbox.stub(operatorNotificationEnqueue, 'enqueueOperatorNotification').resolves()
    sandbox.stub(torClient, 'addOnion').rejects(new Error('tor is not configured'))
    let pid = 1001
    cluster.fork.callsFake(() => createWorker(String(pid), pid++))
    const app = new App(
      fakeProcess as any,
      cluster as any,
      sandbox.stub().returns({
        payments: { enabled: false },
        workers: { count: 1 },
        eventStore: { backend: 'postgres' },
      } as Settings),
    )

    app.run()

    expect(cluster.fork).to.have.been.calledTwice
    expect(cluster.fork.firstCall.args[0]).to.deep.equal({
      WORKER_TYPE: 'worker',
      WORKER_INDEX: '0',
      EVENT_STORE_BACKEND: 'postgres',
    })
    expect(cluster.fork.secondCall.args[0]).to.deep.equal({
      WORKER_TYPE: 'maintenance',
      EVENT_STORE_BACKEND: 'postgres',
    })

    const exitHandlers = cluster.on.getCalls().filter((call) => call.args[0] === 'exit')
    exitHandlers[exitHandlers.length - 1].args[1](cluster.fork.firstCall.returnValue, 1, null)
    await sandbox.clock.tickAsync(10_000)

    expect(cluster.fork).to.have.been.calledThrice
    expect(cluster.fork.thirdCall.args[0]).to.deep.equal(cluster.fork.firstCall.args[0])
  })
})
