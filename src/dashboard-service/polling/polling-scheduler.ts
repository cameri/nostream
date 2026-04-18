import { createLogger } from '../../factories/logger-factory'

type Tick = () => Promise<void> | void

const debug = createLogger('dashboard-service:polling')

export class PollingScheduler {
  private timer: NodeJS.Timer | undefined

  public constructor(
    private readonly intervalMs: number,
    private readonly tick: Tick,
  ) { }

  public start(): void {
    if (this.timer) {
      return
    }

    debug('starting scheduler with interval %d ms', this.intervalMs)

    this.timer = setInterval(() => {
      Promise.resolve(this.tick())
        .catch((error) => {
          console.error('dashboard-service: polling tick failed', error)
        })
    }, this.intervalMs)
  }

  public stop(): void {
    if (!this.timer) {
      return
    }

    debug('stopping scheduler')
    clearInterval(this.timer)
    this.timer = undefined
  }

  public isRunning(): boolean {
    return Boolean(this.timer)
  }
}
