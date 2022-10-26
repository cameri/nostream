import { Cluster, Worker } from 'cluster'
import { cpus } from 'os'

import { IRunnable } from '../@types/base'
import { ISettings } from '../@types/settings'
import packageJson from '../../package.json'
import { Serializable } from 'child_process'

export class App implements IRunnable {
  public constructor(
    private readonly process: NodeJS.Process,
    private readonly cluster: Cluster,
    private readonly settingsFactory: () => ISettings,
  ) {
    this.cluster
      .on('message', this.onClusterMessage.bind(this))
      .on('exit', this.onClusterExit.bind(this))

    this.process
      .on('SIGTERM', this.onExit.bind(this))
  }

  public run(): void {
    console.log(`${packageJson.name}@${packageJson.version}`)
    console.log(`supported NIPs: ${packageJson.supportedNips}`)
    console.log(`primary ${this.process.pid} - running`)

    const workerCount = this.settingsFactory().workers?.count || cpus().length

    for (let i = 0; i < workerCount; i++) {
      this.cluster.fork()
    }
  }

  private onClusterMessage(source: Worker, message: Serializable) {
    for (const worker of Object.values(this.cluster.workers)) {
      if (source.id === worker.id) {
        continue
      }

      worker.send(message)
    }
  }

  private onClusterExit(deadWorker: Worker, code: number, signal: string)  {
      console.log(`worker ${deadWorker.process.pid} - exiting`)
      if (code === 0 || signal === 'SIGINT') {
        return
      }

      this.cluster.fork()
  }

  private onExit() {
    console.log('exiting...')
    this.process.exit(0)
  }
}