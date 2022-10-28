import { IRunnable } from '../@types/base'
import { IWebSocketServerAdapter } from '../@types/adapters'

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
    const port = Number(process.env.SERVER_PORT) || 8008

    this.adapter.listen(port)

    console.log(`worker ${process.pid} - listening on port ${port}`)
  }

  private onMessage(message: { eventName: string, event: unknown }): void {
    this.adapter.emit(message.eventName, message.event)
  }

  private onError(error: Error) {
    console.error(`worker ${process.pid} - error`, error)
    throw error
  }

  private onExit() {
    console.log(`worker ${process.pid} - exiting`)
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    this.adapter.close(callback)
  }
}
