import { createLogger } from '../../factories/logger-factory'

type Tick = () => Promise<void> | void

const debug = createLogger('dashboard-service:polling')

/**
 * Runs a tick callback on a fixed cadence, but — unlike setInterval — never
 * overlaps: the next tick is only scheduled *after* the current one resolves
 * or rejects. This prevents DB query storms when a poll takes longer than the
 * configured interval.
 */
export class PollingScheduler {
  private timer: NodeJS.Timeout | undefined
  private running = false

  public constructor(
    private readonly intervalMs: number,
    private readonly tick: Tick,
  ) { }

  public start(): void {
    if (this.running) {
      return
    }

    this.running = true
    debug('starting scheduler with interval %d ms', this.intervalMs)
    this.scheduleNext()
  }

  public stop(): void {
    if (!this.running) {
      return
    }

    debug('stopping scheduler')
    this.running = false

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  public isRunning(): boolean {
    return this.running
  }

  private scheduleNext(): void {
    if (!this.running) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = undefined

      Promise.resolve(this.tick())
        .catch((error) => {
          console.error('dashboard-service: polling tick failed', error)
        })
        .finally(() => {
          // Schedule the next tick only after the current one completes,
          // regardless of success or failure.
          this.scheduleNext()
        })
    }, this.intervalMs)
  }
}
