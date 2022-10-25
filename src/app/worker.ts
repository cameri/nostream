import http from 'http'
import process from 'process'
import { WebSocketServer } from 'ws'

import { createSettings } from '../factories/settings-factory'
import { IEventRepository } from '../@types/repositories'
import { IRunnable } from '../@types/base'
import { webSocketAdapterFactory } from '../factories/websocket-adapter-factory'
import { WebSocketServerAdapter } from '../adapters/web-socket-server-adapter'

export class AppWorker implements IRunnable {
  private webServer: http.Server
  private wss: WebSocketServer
  private adapter: WebSocketServerAdapter

  public constructor(
    private readonly eventRepository: IEventRepository
  ) {
    this.webServer = http.createServer()
    this.wss = new WebSocketServer({ server: this.webServer, maxPayload: 1024 * 1024 })
    this.adapter = new WebSocketServerAdapter(
      this.webServer,
      this.wss,
      webSocketAdapterFactory(this.eventRepository),
      createSettings,
    )

    process
      .on('message', (message: { eventName: string, event: unknown }) => {
        this.adapter.emit(message.eventName, message.event)
      })
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

  private onError(error: Error) {
    console.error(`worker ${process.pid} - error`, error)
    throw error
  }

  private onExit() {
    console.log(`worker ${process.pid} - exiting`)
    this.wss.close(() => {
      this.webServer.close(() => {
        // dbClient.destroy(() => {
        //   process.exit(0)
        // })
        process.exit(0)
      })
    })
  }
}
