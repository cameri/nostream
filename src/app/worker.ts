import { IRunnable } from '../@types/base'
import { IWebSocketServerAdapter } from '../@types/adapters'

import { createLogger } from '../factories/logger-factory'

const debug = createLogger('app-worker')
export class AppWorker implements IRunnable {
  public constructor(
    private readonly process: NodeJS.Process,
    private readonly adapter: IWebSocketServerAdapter
  ) {
    this.process
      .on('message', this.onMessage.bind(this))
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  public run(): void {
    const port = Number(process.env.PORT) || 8008

    this.adapter.listen(port)
  }

  private onMessage(message: { eventName: string, event: unknown }): void {
    debug('broadcast message received: %o', message)
    this.adapter.emit(message.eventName, message.event)
  }

  private onError(error: Error) {
    debug('error: %o', error)
    throw error
  }

  private onExit() {
    debug('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    debug('closing')
    this.adapter.close(callback)
  }
}
