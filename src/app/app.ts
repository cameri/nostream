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

const debug = createLogger('app-primary')

export class App implements IRunnable {
  private workers: WeakMap<Worker, Record<string, string>>
  private watchers: FSWatcher[] | undefined

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly cluster: Cluster,
    private readonly settings: () => Settings,
  ) {
    debug('starting')

    this.workers = new WeakMap()

    this.cluster
      .on('message', this.onClusterMessage.bind(this))
      .on('exit', this.onClusterExit.bind(this))

    this.process
      .on('SIGTERM', this.onExit.bind(this))

    debug('started')
  }

  public run(): void {
    const settings = this.settings()
    this.watchers = SettingsStatic.watchSettings()
    console.log(`
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
      console.log(' '.repeat(start), input)
    }
    logCentered(`v${packageJson.version}`, width)
    logCentered(`NIPs implemented: ${packageJson.supportedNips}`, width)
    logCentered(`Pay-to-relay ${pathEq(['payments', 'enabled'], true, settings) ? 'enabled' : 'disabled'}`, width)
    logCentered(`Payments provider: ${path(['payments', 'processor'], settings)}`, width)

    const workerCount = process.env.WORKER_COUNT
      ? Number(process.env.WORKER_COUNT)
      : this.settings().workers?.count || cpus().length

    const createWorker = (env: Record<string, string>) => {
      const worker = this.cluster.fork(env)
      this.workers.set(worker, env)
    }

    for (let i = 0; i < workerCount; i++) {
      debug('starting worker')
      createWorker({
        WORKER_TYPE: 'worker',
      })
    }

    createWorker({
      WORKER_TYPE: 'maintenance',
    })

    const mirrors = settings?.mirroring?.static

    if (Array.isArray(mirrors) && mirrors.length) {
      for (let i = 0; i < mirrors.length; i++) {
        createWorker({
          WORKER_TYPE: 'static-mirroring',
          MIRROR_INDEX: i.toString(),
        })
      }
    }

    logCentered(`${workerCount} client workers started`, width)
    logCentered('1 maintenance worker started', width)

    debug('settings: %O', settings)

    const host = `${hostname()}:${port}`
    addOnion(torHiddenServicePort, host).then(value=>{
      logCentered(`Tor hidden service: ${value}:${torHiddenServicePort}`, width)
    }, () => {
      logCentered('Tor hidden service: disabled', width)
    })
  }

  private onClusterMessage(source: Worker, message: Serializable) {
    debug('message received from worker %s: %o', source.process.pid, message)
    for (const worker of Object.values(this.cluster.workers as any) as Worker[]) {
      if (source.id === worker.id) {
        continue
      }

      debug('sending message to worker %s: %o', worker.process.pid, message)
      worker.send(message)
    }
  }

  private onClusterExit(deadWorker: Worker, code: number, signal: string)  {
    debug('worker %s died', deadWorker.process.pid)

    if (code === 0 || signal === 'SIGINT') {
      return
    }
    setTimeout(() => {
      debug('starting worker')
      const workerEnv = this.workers.get(deadWorker)
      if (!workerEnv) {
        throw new Error('Mistakes were made')
      }
      const newWorker = this.cluster.fork(workerEnv)
      this.workers.set(newWorker, workerEnv)

      debug('started worker %s', newWorker.process.pid)
    }, 10000)
  }

  private onExit() {
    console.log('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: (...args: any[]) => void): void {
    console.log('close')
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