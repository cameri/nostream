import EventEmitter from 'events'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { App } from '../../../src/app/app'
import * as metricsTelemetry from '../../../src/telemetry/metrics'
import { Settings } from '../../../src/@types/settings'

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
    await Promise.resolve()

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
})
