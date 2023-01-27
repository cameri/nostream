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
  private watchers: FSWatcher[] | undefined

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly cluster: Cluster,
    private readonly settings: () => Settings,
  ) {
    debug('starting')

    this.cluster
      .on('message', this.onClusterMessage.bind(this))
      .on('exit', this.onClusterExit.bind(this))

    this.process
      .on('SIGTERM', this.onExit.bind(this))

    debug('started')
  }

  public run(): void {
    this.watchers = SettingsStatic.watchSettings()
    const settings = this.settings()
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

    for (let i = 0; i < workerCount; i++) {
      debug('starting worker')
      this.cluster.fork({
        WORKER_TYPE: 'worker',
      })
    }

    this.cluster.fork({
      WORKER_TYPE: 'maintenance',
    })

    logCentered(`${workerCount} workers started`, width)

    debug('settings: %O', settings)

    const host = `${hostname()}:${port}`
    addOnion(torHiddenServicePort, host).then(value=>{
      console.info(`tor hidden service address: ${value}:${torHiddenServicePort}`)
    }, () => {
      console.error('Unable to add Tor hidden service. Skipping.')
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
    debug('starting worker')
    const newWorker = this.cluster.fork()
    debug('started worker %s', newWorker.process.pid)
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