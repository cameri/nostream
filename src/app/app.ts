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

const logger = createLogger('app-primary')

export class App implements IRunnable {
  private workers: WeakMap<Worker, Record<string, string>>
  private watchers: FSWatcher[] | undefined

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
      const start = (width - input.length) >> 1
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

    logger('settings: %O', settings)

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
    for (const worker of Object.values(this.cluster.workers as any) as Worker[]) {
      if (source.id === worker.id) {
        continue
      }

      logger('sending message to worker %s: %o', worker.process.pid, message)
      worker.send(message)
    }
  }

  private onClusterExit(deadWorker: Worker, code: number, signal: string) {
    logger('worker %s died', deadWorker.process.pid)

    if (code === 0 || signal === 'SIGINT') {
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
    logger.info('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: (...args: any[]) => void): void {
    logger.info('close')
    if (Array.isArray(this.watchers)) {
      for (const watcher of this.watchers) {
        watcher.close()
      }
    }
    if (typeof callback === 'function') {
      callback()
    }
  }
}
