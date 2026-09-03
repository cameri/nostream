import EventEmitter from 'events'

import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import {
  buildProbeOptions,
  getProbeIntervalMs,
  RelayMonitorWorker,
} from '../../../src/app/relay-monitor-worker'
import { Settings } from '../../../src/@types/settings'
import * as metricsTelemetry from '../../../src/telemetry/metrics'
import { ProbeResult } from '../../../src/utils/relay-probe/types'

chai.use(sinonChai)

const { expect } = chai

describe('RelayMonitorWorker', () => {
  let sandbox: Sinon.SinonSandbox
  let worker: RelayMonitorWorker
  let fakeProcess: EventEmitter & { exit: Sinon.SinonStub }
  let settings: Sinon.SinonStub
  let settingsState: Settings
  let snapshotStore: {
    saveLatest: Sinon.SinonStub
    getLatest: Sinon.SinonStub
  }
  let probeRunner: Sinon.SinonStub

  const probeResult = (): ProbeResult =>
    ({
      target: {
        relayUrl: 'wss://relay.example.com',
        hostname: 'relay.example.com',
        networkType: 'clearnet',
        httpOrigin: 'https://relay.example.com',
        nip11Url: 'https://relay.example.com/.well-known/nostr.json',
        wsUrl: 'wss://relay.example.com',
      },
      checkedAt: new Date(),
      dns: { status: 'ok', durationMs: 1 },
      tls: { status: 'ok', durationMs: 1 },
      wsRtt: { status: 'ok', durationMs: 1 },
      nip11: { status: 'ok', durationMs: 1 },
    }) as ProbeResult

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.stub(metricsTelemetry, 'shutdownMetricsTelemetry').resolves()

    fakeProcess = Object.assign(new EventEmitter(), {
      exit: sandbox.stub(),
    }) as EventEmitter & { exit: Sinon.SinonStub }

    settingsState = {
      info: {
        relay_url: 'wss://relay.example.com',
      },
      nip66: {
        enabled: true,
        probeIntervalSeconds: 60,
        targets: [],
        timeouts: {
          dnsMs: 10000,
          tlsMs: 10000,
          wsRttMs: 10000,
          nip11Ms: 10000,
        },
        dnsCacheTtlSeconds: 300,
      },
    } as Settings

    settings = sandbox.stub().callsFake(() => settingsState)
    snapshotStore = {
      saveLatest: sandbox.stub().resolves(),
      getLatest: sandbox.stub().resolves(null),
    }
    probeRunner = sandbox.stub().resolves(probeResult())

    worker = new RelayMonitorWorker(fakeProcess as unknown as NodeJS.Process, settings, snapshotStore, probeRunner)
  })

  afterEach(() => {
    worker.close()
    sandbox.restore()
  })

  it('does not start the scheduler when nip66 is disabled', () => {
    settingsState.nip66!.enabled = false
    const setIntervalStub = sandbox.stub(global, 'setInterval')

    worker.run()

    expect(setIntervalStub).to.not.have.been.called
    expect(probeRunner).to.not.have.been.called
  })

  it('runs an initial probe and schedules subsequent runs', async () => {
    const clock = sandbox.useFakeTimers()

    worker.run()
    await Promise.resolve()

    expect(probeRunner).to.have.been.calledOnceWith('wss://relay.example.com', buildProbeOptions(settingsState))
    expect(snapshotStore.saveLatest).to.have.been.calledOnce

    probeRunner.resetHistory()
    snapshotStore.saveLatest.resetHistory()

    await clock.tickAsync(60_000)

    expect(probeRunner).to.have.been.calledOnce
    expect(snapshotStore.saveLatest).to.have.been.calledOnce

    clock.restore()
  })

  it('skips overlapping scheduled runs', async () => {
    const clock = sandbox.useFakeTimers()
    let resolveProbe: (() => void) | undefined
    probeRunner.callsFake(
      () =>
        new Promise<ProbeResult>((resolve) => {
          resolveProbe = () => resolve(probeResult())
        }),
    )

    worker.run()
    await Promise.resolve()

    expect(probeRunner).to.have.been.calledOnce

    const tickPromise = clock.tickAsync(60_000)
    await Promise.resolve()

    expect(probeRunner).to.have.been.calledOnce

    resolveProbe?.()
    await tickPromise
    clock.restore()
  })

  it('builds probe options from nip66 settings', () => {
    expect(buildProbeOptions(settingsState)).to.deep.equal({
      timeouts: settingsState.nip66!.timeouts,
      dnsCacheTtlSeconds: 300,
    })
  })

  it('enforces a minimum probe interval', () => {
    settingsState.nip66!.probeIntervalSeconds = 10
    expect(getProbeIntervalMs(settingsState)).to.equal(60_000)
  })

  it('calls close and then exits the process with code 0', async () => {
    fakeProcess.emit('SIGTERM')
    await new Promise((resolve) => setImmediate(resolve))
    expect(fakeProcess.exit).to.have.been.calledOnceWithExactly(0)
  })

  it('publishes NIP-66 events after saving a probe snapshot', async () => {
    const eventPublisher = {
      publishAfterProbe: sandbox.stub().resolves(),
    }

    worker = new RelayMonitorWorker(
      fakeProcess as unknown as NodeJS.Process,
      settings,
      snapshotStore,
      probeRunner,
      eventPublisher,
    )

    worker.run()
    await Promise.resolve()
    await Promise.resolve()

    expect(eventPublisher.publishAfterProbe).to.have.been.calledOnce
    expect(eventPublisher.publishAfterProbe.firstCall.args[0].status).to.equal('ok')
  })
})
