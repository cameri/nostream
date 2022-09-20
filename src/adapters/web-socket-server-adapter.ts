import { IncomingMessage, Server } from 'http'
import WebSocket, { OPEN, WebSocketServer } from 'ws'

import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { Event } from '../@types/event'
import { Factory } from '../@types/base'
import { propEq } from 'ramda'
import { WebServerAdapter } from './web-server-adapter'


const WSS_CLIENT_HEALTH_PROBE_INTERVAL = 30000

export class WebSocketServerAdapter extends WebServerAdapter implements IWebSocketServerAdapter {
  private webSocketsAdapters: WeakMap<WebSocket, IWebSocketAdapter>

  private heartbeatInterval: NodeJS.Timer

  public constructor(
    webServer: Server,
    private readonly webSocketServer: WebSocketServer,
    private readonly createWebSocketAdapter: Factory<
      IWebSocketAdapter,
      [WebSocket, IncomingMessage, IWebSocketServerAdapter]
    >
  ) {
    super(webServer)

    this.webSocketsAdapters = new WeakMap()

    this
      .on(WebSocketServerAdapterEvent.Broadcast, this.onBroadcast.bind(this))

    this.webSocketServer
      .on(WebSocketServerAdapterEvent.Close, this.onClose.bind(this))
      .on(WebSocketServerAdapterEvent.Connection, this.onConnection.bind(this))

    this.heartbeatInterval = setInterval(this.onHeartbeat.bind(this), WSS_CLIENT_HEALTH_PROBE_INTERVAL)
  }

  public async terminate(): Promise<void> {
    return void Promise.all(
      [
        ...Array.from(this.webSocketServer.clients).map((webSocket: WebSocket) =>
          webSocket.terminate()
        ),
      ],
    )
  }

  private onBroadcast(event: Event) {
    this.webSocketServer.clients.forEach((webSocket: WebSocket) => {
      if (!propEq('readyState', OPEN)(webSocket)) {
        return
      }

      this.webSocketsAdapters.get(webSocket).emit(WebSocketAdapterEvent.Event, event)
    })
  }

  public getConnectedClients(): number {
    return Array.from(this.webSocketServer.clients).filter(propEq('readyState', OPEN)).length
  }

  private onConnection(client: WebSocket, req: IncomingMessage) {
    console.debug(`worker ${process.pid} - new client - ${this.webSocketServer.clients.size} clients`)
    this.webSocketsAdapters.set(client, this.createWebSocketAdapter([client, req, this]))
  }

  private onHeartbeat() {
    this.webSocketServer.clients.forEach((webSocket) =>
      this.webSocketsAdapters.get(webSocket).emit(WebSocketAdapterEvent.Heartbeat)
    )
  }

  protected onClose() {
    this.webSocketServer.clients.forEach((webSocket: WebSocket) =>
      webSocket.terminate()
    )
    console.debug(`worker ${process.pid} - websocket server closing`)
    clearInterval(this.heartbeatInterval)
    this.removeAllListeners()
    this.webSocketServer.removeAllListeners()
    super.onClose()
  }
}
