import { Cluster, Worker } from 'cluster'
import { cpus, hostname } from 'os'
import { path, pathEq } from 'ramda'
import { FSWatcher } from 'fs'

import { addOnion } from '../tor/client'
import { createLogger } from '../factories/logger-factory'
import { IRunnable } from '../@types/base'
import packageJson from '../../package.json'
import { Serializable } from 'child_process'
import { Settings } from '../@types/settings'
import { SettingsStatic } from '../utils/settings'
import { shutdownMetricsTelemetry } from '../telemetry/metrics'
import { OperatorNotificationEventType } from '../@types/operator-notifications'
import { RedisRelayBroadcastFanout } from '../relay-broadcast/redis-relay-broadcast-fanout'
import { enqueueOperatorNotification } from '../utils/operator-notification-enqueue'
import { RelayBroadcastDeduplicator } from '../utils/relay-broadcast-deduplicator'
import {
  isRelayBroadcastFanoutEnabled,
  isRelayBroadcastMessage,
  RelayBroadcastMessage,
} from '../utils/relay-broadcast-message'
import { getPrimaryShutdownDeadlineMs } from '../utils/shutdown-state'

const logger = createLogger('app-primary')

export class App implements IRunnable {
  private workers: WeakMap<Worker, Record<string, string>>
  private watchers: FSWatcher[] | undefined
  private relayBroadcastFanout: RedisRelayBroadcastFanout | undefined
  private readonly relayBroadcastDeduplicator = new RelayBroadcastDeduplicator()
  private shuttingDown = false

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly cluster: Cluster,
    private readonly settings: () => Settings,
  ) {
    logger('starting')

    this.workers = new WeakMap()

    this.cluster.on('message', this.onClusterMessage.bind(this)).on('exit', this.onClusterExit.bind(this))

    this.process.on('SIGTERM', this.onExit.bind(this))

    logger('started')
  }

  public run(): void {
    const settings = this.settings()
    this.watchers = SettingsStatic.watchSettings()
    logger.info(`
 ███▄    █  ▒█████    ██████ ▄▄▄█████▓ ██▀███  ▓█████ ▄▄▄       ███▄ ▄███▓
 ██ ▀█   █ ▒██▒  ██▒▒██    ▒ ▓  ██▒ ▓▒▓██ ▒ ██▒▓█   ▀▒████▄    ▓██▒▀█▀ ██▒
▓██  ▀█ ██▒▒██░  ██▒░ ▓██▄   ▒ ▓██░ ▒░▓██ ░▄█ ▒▒███  ▒██  ▀█▄  ▓██    ▓██░
▓██▒  ▐▌██▒▒██   ██░  ▒   ██▒░ ▓██▓ ░ ▒██▀▀█▄  ▒▓█  ▄░██▄▄▄▄██ ▒██    ▒██
▒██░   ▓██░░ ████▓▒░▒██████▒▒  ▒██▒ ░ ░██▓ ▒██▒░▒████▒▓█   ▓██▒▒██▒   ░██▒
░ ▒░   ▒ ▒ ░ ▒░▒░▒░ ▒ ▒▓▒ ▒ ░  ▒ ░░   ░ ▒▓ ░▒▓░░░ ▒░ ░▒▒   ▓▒█░░ ▒░   ░  ░
░ ░░   ░ ▒░  ░ ▒ ▒░ ░ ░▒  ░ ░    ░      ░▒ ░ ▒░ ░ ░  ░ ▒   ▒▒ ░░  ░      ░
   ░   ░ ░ ░ ░ ░ ▒  ░  ░  ░    ░        ░░   ░    ░    ░   ▒   ░      ░
         ░     ░ ░        ░              ░        ░  ░     ░  ░       ░`)
    const width = 74
    const torHiddenServicePort = process.env.HIDDEN_SERVICE_PORT ? Number(process.env.HIDDEN_SERVICE_PORT) : 80
    const port = process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : 8008

    const logCentered = (input: string, width: number) => {
      const start = Math.max(0, (width - input.length) >> 1)
      logger.info(' '.repeat(start), input)
    }
    logCentered(`v${packageJson.version}`, width)
    logCentered(`NIPs implemented: ${packageJson.supportedNips}`, width)
    const paymentsEnabled = pathEq(['payments', 'enabled'], true, settings)
    logCentered(`Pay-to-relay ${paymentsEnabled ? 'enabled' : 'disabled'}`, width)
    if (paymentsEnabled) {
      logCentered(`Payments provider: ${path(['payments', 'processor'], settings)}`, width)
    }

    if (
      paymentsEnabled &&
      (typeof this.process.env.SECRET !== 'string' ||
        this.process.env.SECRET === '' ||
        this.process.env.SECRET === 'changeme')
    ) {
      logger.error('Please configure the secret using the SECRET environment variable.')
      this.process.exit(1)
    }

    const workerCount = process.env.WORKER_COUNT
      ? Number(process.env.WORKER_COUNT)
      : this.settings().workers?.count || cpus().length

    const createWorker = (env: Record<string, string>) => {
      const worker = this.cluster.fork(env)
      this.workers.set(worker, env)
    }

    for (let i = 0; i < workerCount; i++) {
      logger('starting worker')
      createWorker({
        WORKER_TYPE: 'worker',
        WORKER_INDEX: i.toString(),
      })
    }
    logCentered(`${workerCount} client workers started`, width)

    createWorker({
      WORKER_TYPE: 'maintenance',
    })

    logCentered('1 maintenance worker started', width)
    const mirrors = settings?.mirroring?.static

    if (Array.isArray(mirrors) && mirrors.length) {
      for (let i = 0; i < mirrors.length; i++) {
        createWorker({
          WORKER_TYPE: 'static-mirroring',
          MIRROR_INDEX: i.toString(),
        })
      }
      logCentered(`${mirrors.length} static-mirroring worker started`, width)
    }

    if (settings.nip66?.enabled) {
      createWorker({
        WORKER_TYPE: 'relay-monitor',
      })
      logCentered('1 relay-monitor worker started', width)
    }

    const dvmWorkers = settings?.dvm?.workers

    if (Array.isArray(dvmWorkers) && dvmWorkers.length) {
      for (let i = 0; i < dvmWorkers.length; i++) {
        createWorker({
          WORKER_TYPE: 'dvm-orchestrator',
          DVM_WORKER_INDEX: i.toString(),
        })
      }
      logCentered(`${dvmWorkers.length} dvm-orchestrator worker started`, width)
    }

    logger('settings: %O', settings)

    if (isRelayBroadcastFanoutEnabled()) {
      this.relayBroadcastFanout = new RedisRelayBroadcastFanout()
      void this.relayBroadcastFanout
        .start((message) => this.onRelayBroadcastFromPeer(message))
        .then(() => {
          logCentered('Relay broadcast fan-out enabled (Redis stream)', width)
        })
        .catch((error) => {
          logger.error('relay broadcast fan-out failed to start: %o', error)
          this.relayBroadcastFanout = undefined
        })
    }

    // Primary-only: one outbox event per process start (not per client worker).
    void enqueueOperatorNotification(OperatorNotificationEventType.RELAY_RESTARTED, {
      version: packageJson.version,
      relayPort: port,
    })

    const host = `${hostname()}:${port}`
    addOnion(torHiddenServicePort, host).then(
      (value) => {
        logCentered(`Tor hidden service: ${value}:${torHiddenServicePort}`, width)
      },
      () => {
        logCentered('Tor hidden service: disabled', width)
      },
    )
  }

  private onClusterMessage(source: Worker, message: Serializable) {
    logger('message received from worker %s: %o', source.process.pid, message)

    if (isRelayBroadcastMessage(message)) {
      this.relayBroadcastDeduplicator.mark(message.event.id)
      void this.relayBroadcastFanout?.publish(message)
    }

    this.fanOutClusterMessage(message, source.id)
  }

  private onRelayBroadcastFromPeer(message: RelayBroadcastMessage) {
    if (this.relayBroadcastDeduplicator.has(message.event.id)) {
      logger('skipping duplicate relay broadcast %s', message.event.id)
      return
    }

    this.relayBroadcastDeduplicator.mark(message.event.id)
    this.fanOutClusterMessage(message)
  }

  private fanOutClusterMessage(message: Serializable, excludeWorkerId?: number) {
    for (const worker of Object.values(this.cluster.workers as any) as Worker[]) {
      if (excludeWorkerId !== undefined && worker.id === excludeWorkerId) {
        continue
      }

      logger('sending message to worker %s: %o', worker.process.pid, message)
      worker.send(message)
    }
  }

  private onClusterExit(deadWorker: Worker, code: number, signal: string) {
    logger('worker %s died', deadWorker.process.pid)

    if (this.shuttingDown || code === 0 || signal === 'SIGINT') {
      return
    }
    setTimeout(() => {
      logger('starting worker')
      const workerEnv = this.workers.get(deadWorker)
      if (!workerEnv) {
        throw new Error('Mistakes were made')
      }
      const newWorker = this.cluster.fork(workerEnv)
      this.workers.set(newWorker, workerEnv)

      logger('started worker %s', newWorker.process.pid)
    }, 10000)
  }

  private onExit() {
    if (this.shuttingDown) {
      return
    }
    this.shuttingDown = true
    logger.info('exiting')

    const workers = Object.values(this.cluster.workers ?? {}) as Worker[]
    if (workers.length === 0) {
      this.finishExit()
      return
    }

    let remaining = workers.length
    let finished = false
    let deadline: NodeJS.Timeout | undefined
    const finishOnce = () => {
      if (finished) {
        return
      }
      finished = true
      if (deadline !== undefined) {
        clearTimeout(deadline)
      }
      this.finishExit()
    }

    const onWorkerDone = () => {
      remaining -= 1
      if (remaining <= 0) {
        finishOnce()
      }
    }

    deadline = setTimeout(() => {
      logger.warn('shutdown deadline exceeded, exiting primary')
      finishOnce()
    }, getPrimaryShutdownDeadlineMs())

    for (const worker of workers) {
      worker.once('exit', onWorkerDone)
      worker.kill()
    }
  }

  private finishExit() {
    void shutdownMetricsTelemetry().finally(() => {
      this.close(() => {
        this.process.exit(0)
      })
    })
  }

  public close(callback?: (...args: any[]) => void): void {
    logger.info('close')
    if (Array.isArray(this.watchers)) {
      for (const watcher of this.watchers) {
        watcher.close()
      }
    }
    const stopFanout = this.relayBroadcastFanout?.stop() ?? Promise.resolve()
    void stopFanout.finally(() => {
      if (typeof callback === 'function') {
        callback()
      }
    })
  }
}
