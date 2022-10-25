import cluster, { Worker } from 'cluster'
import { cpus } from 'os'
import process from 'process'

import { IRunnable } from '../@types/base'
import { ISettings } from '../@types/settings'
import packageJson from '../../package.json'
import { Serializable } from 'child_process'

export class App implements IRunnable {
  public constructor(
    private readonly settingsFactory: () => ISettings,
  ) {

    cluster
      .on('message', this.onClusterMessage.bind(this))
      .on('exit', this.onClusterExit.bind(this))

    process
      .on('SIGTERM', this.onExit.bind(this))
  }

  public run(): void {
    console.log(`${packageJson.name}@${packageJson.version}`)
    console.log(`supported NIPs: ${packageJson.supportedNips}`)
    console.log(`primary ${process.pid} - running`)

    const workerCount = this.settingsFactory().workers?.count || cpus().length

    for (let i = 0; i < workerCount; i++) {
      cluster.fork()
    }
  }

  private onClusterMessage(source: Worker, message: Serializable) {
    for (const worker of Object.values(cluster.workers)) {
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
      const worker = cluster.fork()

      const newPID = worker.process.pid
      const oldPID = deadWorker.process.pid

      console.log('worker ' + oldPID + ' died.')
      console.log('worker ' + newPID + ' born.')
  }

  private onExit() {
    console.log('exiting...')
    process.exit(0)
  }
}