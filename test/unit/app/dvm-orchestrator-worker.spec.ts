import chai from 'chai'
import EventEmitter from 'events'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { Settings } from '../../../src/@types/settings'
import { DvmOrchestratorWorker } from '../../../src/app/dvm-orchestrator-worker'
import * as metricsTelemetry from '../../../src/telemetry/metrics'

chai.use(sinonChai)

const { expect } = chai

describe('DvmOrchestratorWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let fakeProcess: EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string> }
  let settings: Sinon.SinonStub
  let settingsState: Settings

  beforeEach(() => {
    sandbox = Sinon.createSandbox()

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
      env: {},
    }) as EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string> }

    settingsState = {
      dvm: {
        workers: [{ command: 'python3', args: ['worker.py'] }],
      },
    } as any

    settings = sandbox.stub().callsFake(() => settingsState)

    sandbox.stub(metricsTelemetry, 'shutdownMetricsTelemetry').resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('run', () => {
    it('logs startup for the worker config at DVM_WORKER_INDEX', () => {
      fakeProcess.env.DVM_WORKER_INDEX = '0'
      const worker = new DvmOrchestratorWorker(fakeProcess as any, settings as any)

      expect(() => worker.run()).to.not.throw()
      expect(fakeProcess.exit).not.to.have.been.called
    })

    it('exits with code 1 if no worker config exists for the given index', () => {
      fakeProcess.env.DVM_WORKER_INDEX = '5'
      const worker = new DvmOrchestratorWorker(fakeProcess as any, settings as any)

      worker.run()

      expect(fakeProcess.exit).to.have.been.calledWith(1)
    })
  })

  describe('signal handling', () => {
    it('closes and exits on SIGTERM', async () => {
      fakeProcess.env.DVM_WORKER_INDEX = '0'
      const worker = new DvmOrchestratorWorker(fakeProcess as any, settings as any)
      worker.run()

      fakeProcess.emit('SIGTERM')

      await Promise.resolve()
      await Promise.resolve()

      expect(fakeProcess.exit).to.have.been.calledWith(0)
    })
  })

  describe('close', () => {
    it('invokes the callback', () => {
      const worker = new DvmOrchestratorWorker(fakeProcess as any, settings as any)
      const callback = sandbox.stub()

      worker.close(callback)

      expect(callback).to.have.been.calledOnce
    })
  })
})
