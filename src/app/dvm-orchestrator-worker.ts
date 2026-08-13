import { path } from 'ramda'
import { IRunnable } from '../@types/base'
import { DvmWorker, Settings } from '../@types/settings'
import { createLogger } from '../factories/logger-factory'
import { shutdownMetricsTelemetry } from '../telemetry/metrics'

const logger = createLogger('dvm-orchestrator-worker')

export class DvmOrchestratorWorker implements IRunnable {
  private config: DvmWorker | undefined

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly settings: () => Settings,
  ) {
    this.process
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  public run(): void {
    const currentSettings = this.settings()

    this.config = path(['dvm', 'workers', this.process.env.DVM_WORKER_INDEX], currentSettings) as DvmWorker | undefined

    if (!this.config) {
      logger.error('no dvm worker config found for index %s', this.process.env.DVM_WORKER_INDEX)
      this.process.exit(1)
      return
    }

    logger.info('dvm-orchestrator worker started for command: %s', this.config.command)
  }

  private onError(error: Error) {
    logger('error: %o', error)
    throw error
  }

  private onExit() {
    logger('exiting')
    void shutdownMetricsTelemetry().finally(() => {
      this.close(() => {
        this.process.exit(0)
      })
    })
  }

  public close(callback?: () => void) {
    logger('closing')
    if (typeof callback === 'function') {
      callback()
    }
  }
}
