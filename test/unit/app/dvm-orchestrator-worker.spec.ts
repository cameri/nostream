import chai from 'chai'
import EventEmitter from 'events'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { DvmJobStatus } from '../../../src/@types/dvm'
import { IDvmJobRepository } from '../../../src/@types/repositories'
import { Settings } from '../../../src/@types/settings'
import { DvmOrchestratorWorker } from '../../../src/app/dvm-orchestrator-worker'
import * as processUtils from '../../../src/cli/utils/process'
import * as metricsTelemetry from '../../../src/telemetry/metrics'
import * as eventUtils from '../../../src/utils/event'

chai.use(sinonChai)

const { expect } = chai

type FakeWorkerHandle = {
  send: Sinon.SinonStub
  kill: Sinon.SinonStub
  onMessage: (handler: (message: unknown) => void) => void
  onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  onSpawnError: (handler: (reason: string) => void) => void
  messageHandler?: (message: unknown) => void
  exitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void
  spawnErrorHandler?: (reason: string) => void
}

const flushMicrotasks = async (ticks = 10): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve()
  }
}

const createFakeWorkerHandle = (): FakeWorkerHandle => {
  const handle: FakeWorkerHandle = {
    send: Sinon.stub(),
    kill: Sinon.stub(),
    onMessage: (handler) => {
      handle.messageHandler = handler
    },
    onExit: (handler) => {
      handle.exitHandler = handler
    },
    onSpawnError: (handler) => {
      handle.spawnErrorHandler = handler
    },
  }
  return handle
}

describe('DvmOrchestratorWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let fakeProcess: EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string> }
  let settings: Sinon.SinonStub
  let settingsState: Settings
  let dvmJobRepository: Sinon.SinonStubbedInstance<IDvmJobRepository>
  let eventRepository: { findByFilters: Sinon.SinonStub; create: Sinon.SinonStub }
  let spawnWorkerProcessStub: Sinon.SinonStub
  let spawnedHandles: FakeWorkerHandle[]
  let worker: DvmOrchestratorWorker | undefined

  const job = {
    id: 'a'.repeat(64),
    requesterPubkey: 'b'.repeat(64),
    kind: 5000,
    workerIndex: null,
    status: DvmJobStatus.SUBMITTED,
    resultEventId: null,
    error: null,
    pickedUpAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const requestEvent = {
    id: job.id,
    pubkey: job.requesterPubkey,
    kind: 5000,
    created_at: 1700000000,
    tags: [],
    content: 'do the job',
    sig: 'sig',
  }

  const currentWorkerHandle = () => spawnedHandles[spawnedHandles.length - 1]

  const createWorker = () =>
    new DvmOrchestratorWorker(fakeProcess as any, settings as any, dvmJobRepository as any, eventRepository as any)

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    worker = undefined
    spawnedHandles = []

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
      env: { DVM_WORKER_INDEX: '0' },
    }) as EventEmitter & { exit: Sinon.SinonStub; env: Record<string, string> }

    settingsState = {
      info: { relay_url: 'wss://relay.test' },
      dvm: {
        workers: [{ command: 'python3', args: ['worker.py'] }],
      },
    } as any

    settings = sandbox.stub().callsFake(() => settingsState)

    dvmJobRepository = {
      create: sandbox.stub(),
      findById: sandbox.stub(),
      assignWorker: sandbox.stub(),
      updateStatus: sandbox.stub(),
      findPendingJobs: sandbox.stub().resolves([]),
    } as any

    eventRepository = {
      findByFilters: sandbox.stub().resolves([{}]),
      create: sandbox.stub().resolves(1),
    }

    spawnWorkerProcessStub = sandbox.stub(processUtils, 'spawnWorkerProcess').callsFake(() => {
      const handle = createFakeWorkerHandle()
      spawnedHandles.push(handle)
      return handle as any
    })

    sandbox.stub(eventUtils, 'toNostrEvent').returns(requestEvent as any)
    sandbox.stub(eventUtils, 'getRelayPrivateKey').returns('relay-privkey')
    sandbox.stub(eventUtils, 'getPublicKey').returns('relay-pubkey')
    sandbox.stub(eventUtils, 'identifyEvent').callsFake(async (event: any) => ({ ...event, id: 'result-id' }))
    sandbox.stub(eventUtils, 'signEvent').returns((event: any) => Promise.resolve({ ...event, sig: 'result-sig' }))
    sandbox.stub(eventUtils, 'broadcastEvent').callsFake(async (event: any) => event)

    sandbox.stub(metricsTelemetry, 'shutdownMetricsTelemetry').resolves()
  })

  afterEach(() => {
    worker?.close()
    sandbox.restore()
  })

  describe('run', () => {
    it('logs startup and spawns the configured worker process', () => {
      worker = createWorker()

      expect(() => worker!.run()).to.not.throw()
      expect(fakeProcess.exit).not.to.have.been.called
      expect(spawnWorkerProcessStub).to.have.been.calledWith('python3', ['worker.py'])
    })

    it('exits with code 1 if no worker config exists for the given index', () => {
      fakeProcess.env.DVM_WORKER_INDEX = '5'
      worker = createWorker()

      worker.run()

      expect(fakeProcess.exit).to.have.been.calledWith(1)
      expect(spawnWorkerProcessStub).not.to.have.been.called
    })
  })

  describe('dispatch', () => {
    let clock: Sinon.SinonFakeTimers

    beforeEach(() => {
      clock = Sinon.useFakeTimers()
    })

    afterEach(() => {
      clock.restore()
    })

    it('does nothing when there are no pending jobs', async () => {
      dvmJobRepository.findPendingJobs.resolves([])
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)

      expect(dvmJobRepository.assignWorker).not.to.have.been.called
      expect(currentWorkerHandle().send).not.to.have.been.called
    })

    it('filters pending jobs by the worker config kinds', async () => {
      settingsState.dvm = { workers: [{ command: 'python3', args: ['worker.py'], kinds: [5000, 5001] }] }
      dvmJobRepository.findPendingJobs.resolves([])
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)

      expect(dvmJobRepository.findPendingJobs).to.have.been.calledWith(1, [5000, 5001])
    })

    it('does not dispatch when it loses the race to assign the job', async () => {
      dvmJobRepository.findPendingJobs.resolves([job])
      dvmJobRepository.assignWorker.resolves(false)
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)

      expect(currentWorkerHandle().send).not.to.have.been.called
    })

    it('fails the job when the source event cannot be found', async () => {
      dvmJobRepository.findPendingJobs.resolves([job])
      dvmJobRepository.assignWorker.resolves(true)
      eventRepository.findByFilters.resolves([])
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)

      expect(dvmJobRepository.updateStatus).to.have.been.calledWithMatch({
        id: job.id,
        status: DvmJobStatus.FAILED,
      })
      expect(currentWorkerHandle().send).not.to.have.been.called
    })

    it('sends the job to the worker process as JSON over its stdin pipe', async () => {
      dvmJobRepository.findPendingJobs.resolves([job])
      dvmJobRepository.assignWorker.resolves(true)
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)

      expect(currentWorkerHandle().send).to.have.been.calledWith(
        Sinon.match({ id: requestEvent.id, kind: requestEvent.kind }),
      )
    })

    it('marks the job completed and publishes a result event when the worker replies', async () => {
      dvmJobRepository.findPendingJobs.resolves([job])
      dvmJobRepository.assignWorker.resolves(true)
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)
      currentWorkerHandle().messageHandler!({ id: requestEvent.id, content: 'result text' })
      await flushMicrotasks()

      expect(eventRepository.create).to.have.been.calledWithMatch({ kind: 6000, content: 'result text' })
      expect(dvmJobRepository.updateStatus).to.have.been.calledWithMatch({
        id: job.id,
        status: DvmJobStatus.COMPLETED,
        resultEventId: 'result-id',
      })
    })

    it('ignores worker replies for jobs that are no longer pending', async () => {
      dvmJobRepository.findPendingJobs.resolves([])
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)

      expect(() => currentWorkerHandle().messageHandler!({ id: 'unknown-job-id', content: 'x' })).to.not.throw()
      expect(dvmJobRepository.updateStatus).not.to.have.been.called
    })

    it('marks the job timed_out and kills the worker when no reply arrives before the configured timeout', async () => {
      settingsState.dvm = { workers: [{ command: 'python3', args: ['worker.py'], timeoutMs: 5000 }] }
      dvmJobRepository.findPendingJobs.resolves([job])
      dvmJobRepository.assignWorker.resolves(true)
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)
      const handle = currentWorkerHandle()
      await clock.tickAsync(5000)

      expect(dvmJobRepository.updateStatus).to.have.been.calledWithMatch({
        id: job.id,
        status: DvmJobStatus.TIMED_OUT,
      })
      expect(handle.kill).to.have.been.calledOnce
    })

    it('marks all in-flight jobs failed when the worker process exits unexpectedly', async () => {
      dvmJobRepository.findPendingJobs.resolves([job])
      dvmJobRepository.assignWorker.resolves(true)
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)
      currentWorkerHandle().exitHandler!(1, null)

      expect(dvmJobRepository.updateStatus).to.have.been.calledWithMatch({
        id: job.id,
        status: DvmJobStatus.FAILED,
      })
    })

    it('respawns the worker process on the next tick after it exits', async () => {
      dvmJobRepository.findPendingJobs.resolves([])
      worker = createWorker()
      worker.run()

      expect(spawnedHandles).to.have.lengthOf(1)
      spawnedHandles[0].exitHandler!(1, null)

      await clock.tickAsync(2000)

      expect(spawnedHandles).to.have.lengthOf(2)
    })

    it('does not dispatch a second job while a previous dispatch is still running', async () => {
      dvmJobRepository.findPendingJobs.returns(new Promise(() => {})) // never resolves
      worker = createWorker()
      worker.run()

      await clock.tickAsync(2000)
      await clock.tickAsync(2000)

      expect(dvmJobRepository.findPendingJobs).to.have.been.calledOnce
    })
  })

  describe('signal handling', () => {
    it('closes and exits on SIGTERM', async () => {
      worker = createWorker()
      worker.run()

      fakeProcess.emit('SIGTERM')

      await Promise.resolve()
      await Promise.resolve()

      expect(fakeProcess.exit).to.have.been.calledWith(0)
    })
  })

  describe('close', () => {
    it('invokes the callback and kills the worker process', () => {
      worker = createWorker()
      worker.run()
      const callback = sandbox.stub()

      worker.close(callback)

      expect(callback).to.have.been.calledOnce
      expect(currentWorkerHandle().kill).to.have.been.calledOnce
    })
  })
})
